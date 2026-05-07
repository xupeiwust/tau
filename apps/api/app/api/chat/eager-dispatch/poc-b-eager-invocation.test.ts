/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/explicit-member-accessibility, @typescript-eslint/member-ordering -- POC mirrors LangChain's BaseChatModel/BaseCallbackHandler API surface (snake_case method names, opt-in literal flags). */
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
import { z } from 'zod';

// POC-B: eager invocation + wrapToolCall short-circuit.
//
// Question: can a callback handler dispatch `tool.invoke()` mid-stream
// (S2 trigger on tool-index advance, S3 trigger on handleLLMEnd) without
// stalling the LLM stream, and can a wrapToolCall middleware short-circuit
// the native ToolNode execution to surface the eager result without
// running the tool a second time?
//
// Pass conditions:
//   1. tool_a:start fires while the LLM is still streaming block 1 (i.e. while
//      tool_b's args are still arriving) — not after the agent step finishes
//   2. tool_b:start fires on S3 (handleLLMEnd) before the tools-superstep runs
//   3. Each :start event appears exactly once (no double execution)
//   4. Final state has both ToolMessages with the eagerly-computed content
//   5. handleLLMNewToken keeps firing between tool_a:start and tool_b:start

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

  // Records every chunk that we emit, keyed by perf-clock millis from instance birth.
  readonly chunkLog: Array<{ t: number; index: number; id: string }> = [];

  constructor(
    private readonly toolCallChunks: ToolCallChunkSpec[],
    private readonly t0: () => number,
  ) {
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
      this.chunkLog.push({ t: performance.now() - this.t0(), index: spec.index, id: spec.id });

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

  // toolCallId -> eager entry
  readonly entries = new Map<string, EagerEntry>();

  // Per-index argument accumulator, captured from incoming tool_call_chunks.
  private readonly perIndex = new Map<number, { id: string; name: string; args: string }>();

  // The highest index we've already dispatched (S2 = "previous index closed").
  private highestDispatchedIndex = -1;

  constructor(private readonly toolsByName: Map<string, StructuredToolInterface>) {
    super();
  }

  // Synchronous return: must NOT block the LLM stream. Fire-and-forget tool.invoke.
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

      // S2: a higher index just appeared, so all indices below it are CLOSED.
      // Dispatch any closed indices we have not yet dispatched.
      for (let i = this.highestDispatchedIndex + 1; i < tcc.index; i++) {
        this.dispatchIndex(i);
      }
    }
  }

  override handleLLMEnd(output: LLMResult): void {
    // S3: stream ended → the highest index is closed. Use the final fully-parsed
    // tool_calls[] from the AIMessage so we get authoritative args for the last block
    // (no partial-JSON parsing concerns).
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
      // Malformed S2 close: still dispatch so the failure surfaces in the eager
      // invokePromise rather than getting silently dropped.
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

    // Fire-and-forget tool.invoke. The promise lives on the entry; wrapToolCall awaits it.
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
      return result;
    })();

    this.entries.set(toolCallId, {
      toolCallId,
      toolName,
      invokePromise,
    });
  }
}

const eagerDispatchMiddleware = (handler: EagerToolDispatchHandler): AgentMiddleware =>
  createMiddleware({
    name: 'EagerDispatchPoc',
    contextSchema: z.object({}),
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

describe('POC-B: eager invocation + wrapToolCall short-circuit', () => {
  it('dispatches tool_a on S2, tool_b on S3, never double-executes, and never blocks the LLM stream', async () => {
    const t0 = performance.now();
    const log: Array<{ t: number; event: string }> = [];
    const tokenLog: Array<{ t: number; index: number | undefined }> = [];

    const sleepTool = (toolName: 'tool_a' | 'tool_b'): StructuredToolInterface =>
      tool(
        async ({ value }: { value: string }): Promise<string> => {
          log.push({ t: performance.now() - t0, event: `${toolName}:start` });
          await sleep(50);
          log.push({ t: performance.now() - t0, event: `${toolName}:done` });
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

    // Tap handleLLMNewToken externally to confirm deltas keep flowing across the boundary.
    class TokenSpy extends BaseCallbackHandler {
      name = 'token-spy';
      readonly lc_prefer_streaming = true;
      override handleLLMNewToken(
        _token: string,
        _idx: NewTokenIndices,
        _runId: string,
        _parentRunId?: string,
        _tags?: string[],
        fields?: HandleLLMNewTokenCallbackFields,
      ): void {
        const chunk = fields?.chunk;
        const message = chunk && 'message' in chunk ? (chunk.message as AIMessageChunk) : undefined;
        const tcc = message?.tool_call_chunks?.[0];
        tokenLog.push({ t: performance.now() - t0, index: tcc?.index });
      }
    }

    const llm = new FakeStreamingToolModel(
      [
        // block 0 (tool_a)
        { index: 0, id: 'call_a', name: 'tool_a', args: '{"value":', delayMs: 0 },
        { index: 0, id: 'call_a', name: 'tool_a', args: '"alpha"}', delayMs: 100 },
        // block 1 (tool_b) — S2 fires here for tool_a
        { index: 1, id: 'call_b', name: 'tool_b', args: '{"value":', delayMs: 100 },
        { index: 1, id: 'call_b', name: 'tool_b', args: '"beta"}', delayMs: 200 },
        // stream ends — S3 fires for tool_b
      ],
      () => t0,
    );

    const agent = createAgent({
      model: llm,
      tools: [toolA, toolB],
      middleware: [eagerDispatchMiddleware(eager)] as const,
    });

    const result = (await agent.invoke(
      { messages: [new HumanMessage('Run tool_a and tool_b in parallel.')] },
      { callbacks: [eager, new TokenSpy()], recursionLimit: 5 },
    )) as { messages: BaseMessage[] };

    // ---- Pass condition 1 & 2: dispatch ordering ----
    // The architectural claim is ordering, not strict wall-clock thresholds, so we
    // assert against stream-relative landmarks (last block-1 chunk emission,
    // handleLLMEnd timing) which are tolerant of scheduler jitter.
    const toolAStart = log.find((entry) => entry.event === 'tool_a:start');
    const toolBStart = log.find((entry) => entry.event === 'tool_b:start');
    const block1ChunksByLLM = llm.chunkLog.filter((entry) => entry.index === 1);
    const lastBlock1ChunkTime = block1ChunksByLLM.at(-1)?.t;

    expect(toolAStart, 'tool_a must have started').toBeDefined();
    expect(toolBStart, 'tool_b must have started').toBeDefined();
    expect(lastBlock1ChunkTime, 'block 1 must have streamed at least one chunk').toBeDefined();

    expect(
      toolAStart!.t,
      `tool_a:start must fire on S2 (index advance) BEFORE the last block-1 chunk emits (t_a=${toolAStart!.t}ms, last_block1=${lastBlock1ChunkTime!}ms). Strict ordering proves dispatch is not waiting for stream end.`,
    ).toBeLessThan(lastBlock1ChunkTime!);

    expect(
      toolBStart!.t,
      `tool_b:start must fire after the last block-1 chunk (S3) (t_b=${toolBStart!.t}ms, last_block1=${lastBlock1ChunkTime!}ms).`,
    ).toBeGreaterThanOrEqual(lastBlock1ChunkTime!);

    // ---- Pass condition 3: each :start exactly once (no double exec) ----
    const aStartCount = log.filter((entry) => entry.event === 'tool_a:start').length;
    const bStartCount = log.filter((entry) => entry.event === 'tool_b:start').length;
    expect(aStartCount, 'tool_a must execute exactly once').toBe(1);
    expect(bStartCount, 'tool_b must execute exactly once').toBe(1);

    // ---- Pass condition 4: final state contains both eagerly-computed ToolMessages ----
    const toolMessages = result.messages.filter((message): message is ToolMessage => ToolMessage.isInstance(message));
    const contents = toolMessages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .sort((a, b) => a.localeCompare(b));
    expect(contents).toEqual(['tool_a:alpha', 'tool_b:beta']);

    // ---- Pass condition 5: deltas keep flowing across tool_a:start ----
    // The TokenSpy must observe at least one index=1 chunk AFTER tool_a:start.
    // If handleLLMNewToken were blocking, the LLM stream would stall until tool_a finishes.
    const indexOneAfterToolA = tokenLog.filter((entry) => entry.index === 1 && entry.t > toolAStart!.t);
    expect(
      indexOneAfterToolA.length,
      'block-1 chunks must continue to arrive after tool_a:start (proves no LLM-stream backpressure)',
    ).toBeGreaterThanOrEqual(1);
  });
});
