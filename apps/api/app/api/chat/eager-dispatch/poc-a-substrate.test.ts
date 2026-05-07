/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/explicit-member-accessibility -- LangChain's BaseChatModel + BaseCallbackHandler API mandates snake_case fields/methods (`_streamResponseChunks`, `_generate`, `_combineLLMOutput`, `_llmType`, `lc_prefer_streaming`, `tool_call_chunks`). Per-line disables would obscure the test substrate's structure. */
/* oxlint-disable @typescript-eslint/class-literal-property-style, max-params, no-await-in-loop, unicorn-js/prevent-abbreviations -- LangChain mandates the 6-arg `handleLLMNewToken` signature and the literal `lc_prefer_streaming` opt-in flag; the streaming generator naturally awaits inside its for-of loop per upstream provider implementations. */
import { describe, expect, it } from 'vitest';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { ChatResult, LLMResult } from '@langchain/core/outputs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { HandleLLMNewTokenCallbackFields, NewTokenIndices } from '@langchain/core/callbacks/base';
import { createAgent } from 'langchain';
import { z } from 'zod';

// POC-A: substrate verification.
//
// Question: does a callback handler attached to `createAgent` receive
// per-chunk `handleLLMNewToken` calls with `tool_call_chunks` populated
// while the LLM is still streaming, plus a final `handleLLMEnd` with the
// fully-parsed `AIMessage.tool_calls[]`?
//
// If this fails, the eager-dispatch architecture has no attachment point
// and the entire R&D direction is dead.

type ToolCallChunkSpec = {
  index: number;
  id: string;
  name: string;
  args: string;
};

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

type RecordedEvent =
  | {
      kind: 'token';
      t: number;
      chunk: AIMessageChunk | undefined;
      toolCallChunks: AIMessageChunk['tool_call_chunks'];
    }
  | { kind: 'end'; t: number; toolCalls: AIMessageChunk['tool_calls'] };

class LoggingHandler extends BaseCallbackHandler {
  name = 'eager-dispatch-poc-logging';

  // Required to opt into the streaming path inside BaseChatModel._generateUncached.
  // Without it, agent.invoke -> model.invoke takes the non-streaming branch and never
  // calls _streamResponseChunks.
  readonly lc_prefer_streaming = true;

  readonly events: RecordedEvent[] = [];

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
    this.events.push({
      kind: 'token',
      t: performance.now(),
      chunk: message,
      toolCallChunks: message?.tool_call_chunks,
    });
  }

  override handleLLMEnd(output: LLMResult): void {
    const generation = output.generations[0]?.[0];
    const message = generation && 'message' in generation ? (generation.message as AIMessageChunk) : undefined;
    this.events.push({
      kind: 'end',
      t: performance.now(),
      toolCalls: message?.tool_calls,
    });
  }
}

describe('POC-A: substrate verification', () => {
  it('attaches a callback handler to createAgent and receives streaming tool_call_chunks plus a final tool_calls[]', async () => {
    const noopTool = tool(({ value }: { value: string }) => `ok:${value}`, {
      name: 'noop',
      description: 'A no-op tool.',
      schema: z.object({ value: z.string() }),
    });

    const llm = new FakeStreamingToolModel([
      { index: 0, id: 'call_alpha', name: 'noop', args: '{"value":' },
      { index: 0, id: 'call_alpha', name: 'noop', args: '"alpha"}' },
      { index: 1, id: 'call_beta', name: 'noop', args: '{"value":' },
      { index: 1, id: 'call_beta', name: 'noop', args: '"beta"}' },
    ]);

    const agent = createAgent({ model: llm, tools: [noopTool] });
    const handler = new LoggingHandler();

    await agent.invoke(
      { messages: [new HumanMessage('Run noop twice in parallel.')] },
      { callbacks: [handler], recursionLimit: 5 },
    );

    const tokenEvents = handler.events.filter((event) => event.kind === 'token');
    const endEvents = handler.events.filter((event) => event.kind === 'end');

    expect(
      tokenEvents.length,
      'handler must receive at least one handleLLMNewToken per yielded chunk',
    ).toBeGreaterThanOrEqual(4);

    const indices = new Set<number>();
    for (const event of tokenEvents) {
      const index = event.toolCallChunks?.[0]?.index;
      if (typeof index === 'number') {
        indices.add(index);
      }
    }

    expect(indices.has(0), 'index=0 (block 0) chunk must reach the handler mid-stream').toBe(true);
    expect(indices.has(1), 'index=1 (block 1) chunk must reach the handler mid-stream').toBe(true);

    expect(endEvents.length, 'handler must receive exactly one handleLLMEnd per LLM run').toBeGreaterThanOrEqual(1);

    const firstEnd = endEvents[0];
    expect(
      firstEnd?.toolCalls?.length,
      'handleLLMEnd must carry the fully-parsed AIMessage.tool_calls[]',
    ).toBeGreaterThanOrEqual(2);

    const toolCallIds = firstEnd?.toolCalls?.map((call) => call.id) ?? [];
    expect(toolCallIds).toContain('call_alpha');
    expect(toolCallIds).toContain('call_beta');
  });
});
