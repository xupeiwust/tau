/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/explicit-member-accessibility -- POC mirrors LangChain's BaseChatModel/BaseCallbackHandler API surface (snake_case method names, opt-in literal flags). */
/* oxlint-disable @typescript-eslint/class-literal-property-style, max-params, no-await-in-loop, unicorn-js/prevent-abbreviations, tau-lint/no-time-unit-suffix, capitalized-comments -- LangChain mandates the 6-arg `handleLLMNewToken` signature, the literal `lc_prefer_streaming` opt-in flag, and the chunk-specs use `delayMs` for legibility against this self-contained POC fixture. */
import { describe, expect, it } from 'vitest';
import { AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { ChatResult, LLMResult } from '@langchain/core/outputs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { HandleLLMNewTokenCallbackFields, NewTokenIndices } from '@langchain/core/callbacks/base';
import { isCommand } from '@langchain/langgraph';
import type { Command } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { UIMessageChunk } from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { z } from 'zod';

// POC-C: wire-side timing.
//
// Question: when an eagerly-dispatched tool result is emitted via the
// LangGraph 'custom' channel, does it cross the toUIMessageStream boundary
// BEFORE the next tool's `tool-input-available` chunk?
//
// We deliberately use the 'custom' channel here (instead of LangGraph 1.2's
// dedicated 'tools' stream mode) because the AI SDK adapter on the version
// pinned in this workspace already understands `case 'custom':` -> `data-${type}`
// and we only need to verify TIMING, not the eventual production wire-shape.
//
// Pass condition:
//   for the parallel pair (tool_a, tool_b),
//     data-eager-tool-output(toolCallId=call_a) lands BEFORE
//     tool-input-available(toolCallId=call_b)
//
// If POC-B passed but POC-C fails, the architecture is sound but the
// emission/adapter boundary needs additional plumbing. If both pass, the
// architecture is wire-side viable.

type ToolCallChunkSpec = {
  index: number;
  id: string;
  name: string;
  args: string;
  /** Milliseconds. */
  delayMs: number;
};

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

class FakeStreamingToolModel extends BaseChatModel {
  private callCount = 0;

  constructor(private readonly toolCallChunks: ToolCallChunkSpec[]) {
    super({});
  }

  override _llmType(): string {
    return 'fake-streaming-tool-model';
  }

  override _combineLLMOutput(): Record<string, unknown> {
    return {};
  }

  override bindTools(): this {
    return this;
  }

  override async _generate(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    throw new Error('FakeStreamingToolModel only supports streaming.');
  }

  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.callCount += 1;
    if (this.callCount > 1) {
      const message = new AIMessageChunk({ content: 'done' });
      const generationChunk = new ChatGenerationChunk({ message, text: 'done' });
      yield generationChunk;
      await runManager?.handleLLMNewToken('done', undefined, undefined, undefined, undefined, {
        chunk: generationChunk,
      });
      return;
    }

    for (const spec of this.toolCallChunks) {
      await sleep(spec.delayMs);

      const message = new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            index: spec.index,
            id: spec.id,
            name: spec.name,
            args: spec.args,
            type: 'tool_call_chunk',
          },
        ],
      });

      const generationChunk = new ChatGenerationChunk({ message, text: '' });
      yield generationChunk;

      await runManager?.handleLLMNewToken('', undefined, undefined, undefined, undefined, {
        chunk: generationChunk,
      });
    }
  }
}

type EagerEntry = {
  toolCallId: string;
  toolName: string;
  invokePromise: Promise<ToolMessage | Command>;
  result?: ToolMessage | Command;
};

class EagerToolDispatchHandler extends BaseCallbackHandler {
  name = 'eager-tool-dispatch';

  readonly lc_prefer_streaming = true;

  readonly entries = new Map<string, EagerEntry>();

  private readonly perIndex = new Map<number, { id: string; name: string; args: string }>();

  private highestDispatchedIndex = -1;

  private writer: ((chunk: unknown) => void) | undefined;

  constructor(private readonly toolsByName: Map<string, StructuredToolInterface>) {
    super();
  }

  // Wired by the eagerDispatchMiddleware's wrapModelCall hook so the eager
  // handler can emit on the LangGraph 'custom' channel after tool.invoke()
  // resolves (whose .then callback can lose async-hooks context).
  setWriter(writer: ((chunk: unknown) => void) | undefined): void {
    this.writer = writer;
  }

  hasWriter(): boolean {
    return this.writer !== undefined;
  }

  override handleLLMNewToken(
    _token: string,
    _idx: NewTokenIndices,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: HandleLLMNewTokenCallbackFields,
  ): void {
    const chunk = fields?.chunk;
    if (!chunk || !('message' in chunk)) {
      return;
    }
    const message = chunk.message as AIMessageChunk;
    const toolCallChunks = message.tool_call_chunks ?? [];
    if (toolCallChunks.length === 0) {
      return;
    }

    for (const tcc of toolCallChunks) {
      if (typeof tcc.index !== 'number') {
        continue;
      }

      const slot = this.perIndex.get(tcc.index) ?? { id: '', name: '', args: '' };
      slot.id = tcc.id ?? slot.id;
      slot.name = tcc.name ?? slot.name;
      slot.args = `${slot.args}${tcc.args ?? ''}`;
      this.perIndex.set(tcc.index, slot);

      for (let i = this.highestDispatchedIndex + 1; i < tcc.index; i++) {
        this.dispatchIndex(i);
      }
    }
  }

  override handleLLMEnd(output: LLMResult): void {
    const generation = output.generations[0]?.[0];
    const message = generation && 'message' in generation ? (generation.message as AIMessageChunk) : undefined;
    const toolCalls = message?.tool_calls ?? [];

    for (const call of toolCalls) {
      let matchedIndex = -1;
      for (const [index, slot] of this.perIndex.entries()) {
        if (slot.id === call.id) {
          matchedIndex = index;
          break;
        }
      }
      if (matchedIndex < 0) {
        continue;
      }

      if (matchedIndex > this.highestDispatchedIndex) {
        this.dispatchIndexWithParsedArgs(matchedIndex, call.id ?? '', call.name, call.args);
      }
    }
  }

  private dispatchIndex(index: number): void {
    const slot = this.perIndex.get(index);
    if (!slot) {
      return;
    }

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(slot.args) as Record<string, unknown>;
    } catch {
      // Malformed args — surface as eager invocation error rather than dropping.
    }

    this.dispatchIndexWithParsedArgs(index, slot.id, slot.name, parsedArgs);
  }

  private dispatchIndexWithParsedArgs(
    index: number,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    if (index <= this.highestDispatchedIndex) {
      return;
    }
    this.highestDispatchedIndex = index;

    const targetTool = this.toolsByName.get(toolName);
    if (!targetTool) {
      return;
    }

    const { writer } = this;
    const invokePromise = (async (): Promise<ToolMessage | Command> => {
      const output: unknown = await targetTool.invoke({
        name: toolName,
        args,
        id: toolCallId,
        type: 'tool_call',
      });
      const result: ToolMessage | Command =
        ToolMessage.isInstance(output) || isCommand(output)
          ? output
          : new ToolMessage({
              name: toolName,
              content: typeof output === 'string' ? output : JSON.stringify(output),
              tool_call_id: toolCallId,
            });

      const stored = this.entries.get(toolCallId);
      if (stored) {
        stored.result = result;
      }

      // Emit on the LangGraph 'custom' channel so toUIMessageStream surfaces this
      // result on the wire BEFORE the tools-superstep's tool-output-available.
      writer?.({
        type: 'eager-tool-output',
        toolCallId,
        output: result instanceof ToolMessage ? result.content : null,
      });

      return result;
    })();

    this.entries.set(toolCallId, { toolCallId, toolName, invokePromise });
  }
}

const eagerDispatchMiddleware = (handler: EagerToolDispatchHandler): AgentMiddleware =>
  createMiddleware({
    name: 'EagerDispatchPocC',
    contextSchema: z.object({}),
    async wrapModelCall(request, baseHandler) {
      // Capture the LangGraph 'custom' channel writer for the agent task so the
      // handler can emit eagerly-dispatched tool outputs from within tool.invoke
      // .then() callbacks (whose async-hooks context may have drifted).
      const { writer } = request.runtime as { writer?: (chunk: unknown) => void };
      handler.setWriter(writer);
      return baseHandler(request);
    },
    async wrapToolCall(request, baseHandler) {
      const entry = handler.entries.get(request.toolCall.id ?? '');
      if (!entry) {
        return baseHandler(request);
      }
      if (entry.result !== undefined) {
        return entry.result;
      }
      return entry.invokePromise;
    },
  });

describe('POC-C: wire-side timing through toUIMessageStream', () => {
  it("eagerly-emitted tool_a output crosses the wire before tool_b's tool-input-available", async () => {
    const t0 = performance.now();
    type StampedChunk = { t: number; chunk: UIMessageChunk };
    const wireLog: StampedChunk[] = [];

    const sleepTool = (toolName: 'tool_a' | 'tool_b'): StructuredToolInterface =>
      tool(
        async ({ value }: { value: string }): Promise<string> => {
          await sleep(50);
          return `${toolName}:${value}`;
        },
        {
          name: toolName,
          description: `${toolName} sleep tool`,
          schema: z.object({ value: z.string() }),
        },
      ) as unknown as StructuredToolInterface;

    const toolA = sleepTool('tool_a');
    const toolB = sleepTool('tool_b');
    const toolsByName = new Map<string, StructuredToolInterface>([
      ['tool_a', toolA],
      ['tool_b', toolB],
    ]);

    const eager = new EagerToolDispatchHandler(toolsByName);

    const llm = new FakeStreamingToolModel([
      { index: 0, id: 'call_a', name: 'tool_a', args: '{"value":', delayMs: 0 },
      { index: 0, id: 'call_a', name: 'tool_a', args: '"alpha"}', delayMs: 100 },
      { index: 1, id: 'call_b', name: 'tool_b', args: '{"value":', delayMs: 100 },
      { index: 1, id: 'call_b', name: 'tool_b', args: '"beta"}', delayMs: 200 },
    ]);

    const agent = createAgent({
      model: llm,
      tools: [toolA, toolB],
      middleware: [eagerDispatchMiddleware(eager)] as const,
    });

    const graphStream = await agent.graph.stream(
      { messages: [new HumanMessage('Run tool_a and tool_b in parallel.')] },
      {
        callbacks: [eager],
        streamMode: ['values', 'messages', 'custom'],
        recursionLimit: 5,
      },
    );

    const uiStream = toUIMessageStream(graphStream);
    const reader = uiStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      wireLog.push({ t: performance.now() - t0, chunk: value });
    }

    const eagerToolAOutput = wireLog.find(
      (entry) =>
        entry.chunk.type === 'data-eager-tool-output' &&
        (entry.chunk as unknown as { data?: { toolCallId?: string } }).data?.toolCallId === 'call_a',
    );
    const toolBInputAvailable = wireLog.find(
      (entry) =>
        entry.chunk.type === 'tool-input-available' &&
        (entry.chunk as unknown as { toolCallId?: string }).toolCallId === 'call_b',
    );

    const debug = `writerWired=${eager.hasWriter()}, chunks=[${wireLog.map((entry) => entry.chunk.type).join(', ')}]`;
    expect(eagerToolAOutput, `data-eager-tool-output for call_a must reach the wire — ${debug}`).toBeDefined();
    expect(toolBInputAvailable, 'tool-input-available for call_b must reach the wire').toBeDefined();

    expect(
      eagerToolAOutput!.t,
      `tool_a's eager output (t=${eagerToolAOutput!.t}ms) must land before tool_b's tool-input-available (t=${toolBInputAvailable!.t}ms)`,
    ).toBeLessThan(toolBInputAvailable!.t);
  });
});
