// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/explicit-member-accessibility -- LangChain's BaseChatModel API mandates snake_case fields/methods (`_generate`, `_combineLLMOutput`, `_llmType`) and protected member shorthand. */
/* oxlint-disable @typescript-eslint/class-literal-property-style -- LangChain BaseChatModel pattern. */
/**
 * Durability contract for the `_recentReads` checkpoint channel.
 *
 * The audit (docs/research/content-replacement-state-durability-audit.md)
 * called out a smoking-gun durability gap: the prior in-process
 * `ContentReplacementStateRegistry` lost the `read_file` dedup pointer on
 * every Fly auto-stop, redeploy, cross-instance hop, and >1 week revisit.
 * The plan replaces that with the `_recentReads` LangGraph state channel
 * persisted by `MemorySaver` (tests) / `PostgresSaver` (production).
 *
 * This integration test pins the durability contract end-to-end:
 *
 * 1. Build agent A with a `MemorySaver` checkpointer + the dedup state
 *    middleware + the real `readFileTool`. Drive turn 1 with a fake LLM
 *    that emits a single `read_file` tool call. Assert the checkpoint
 *    now contains a `_recentReads` entry for the read fingerprint.
 * 2. Throw away agent A. Build agent B from scratch using the SAME
 *    `MemorySaver` + same `thread_id`. Drive turn 2 with the same
 *    `read_file` invocation. Assert the resulting `ToolMessage` carries
 *    the `fileUnchangedMarker`, proving the dedup state hydrated from
 *    the checkpoint across the simulated process restart.
 */
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { createAgent } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { fileUnchangedMarker, toolName } from '@taucad/chat/constants';
import { readFileTool } from '#api/tools/tools/tool-read-file.js';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';
import { buildReadFingerprint, createReadDedupStateMiddleware } from '#api/chat/state/recent-reads-state.js';

/**
 * Minimal fake model that emits one tool call on the first invocation and a
 * terminating text response on every subsequent call. Lets us drive the
 * agent through exactly one tool round-trip per turn without invoking a
 * real LLM provider.
 */
class ScriptedToolModel extends BaseChatModel {
  callCount = 0;

  constructor(private readonly toolCallId: string) {
    super({});
  }

  override _llmType(): string {
    return 'scripted-tool-model';
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
    this.callCount += 1;
    if (this.callCount === 1) {
      const message = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: this.toolCallId,
            name: toolName.readFile,
            args: { targetFile: 'shared/index.ts' },
            type: 'tool_call',
          },
        ],
      });
      return { generations: [{ text: '', message }] };
    }

    const message = new AIMessage({ content: 'done' });
    return { generations: [{ text: 'done', message }] };
  }
}

const buildChatRpcService = (modifiedAt: string): ChatRpcConfigurable['chatRpcService'] => {
  const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
  chatRpcService.sendRpcRequest.mockResolvedValue({
    success: true,
    content: 'export const value = 1;',
    totalLines: 1,
    startLine: 1,
    modifiedAt,
  });
  return chatRpcService;
};

const findReadFileToolMessage = (messages: BaseMessage[]): ToolMessage => {
  for (const message of messages) {
    if (message instanceof ToolMessage && message.name === toolName.readFile) {
      // ToolMessage's default generic resolves to `any` from the @langchain/core
      // types — the explicit `ToolMessage` annotation here is the closest the
      // call site can get without leaking the upstream MessageStructure
      // generic into every helper signature.
      return message as ToolMessage;
    }
  }
  throw new Error(
    `No read_file ToolMessage in agent state (saw: ${messages.map((m) => m.constructor.name).join(', ')})`,
  );
};

type AgentSnapshot = {
  messages: BaseMessage[];
  _recentReads?: Record<string, { priorToolCallId: string; modifiedAt: string }>;
};

/**
 * Extracts the durable channel snapshot from `agent.getState(config)`. The
 * agent type carries no surface for the user-defined `_recentReads` channel
 * (its inferred state shape is `never` in tsgo's view of `createAgent`'s
 * generic), so cast through `unknown` once at the boundary and access the
 * channel via {@link AgentSnapshot}.
 */
const snapshotValues = async (
  agent: ReturnType<typeof createAgent>,
  config: { configurable: { thread_id: string } },
): Promise<AgentSnapshot> => {
  const state = await (agent as unknown as { getState(config: unknown): Promise<{ values: unknown }> }).getState(
    config,
  );
  return state.values as AgentSnapshot;
};

const parseToolMessage = (message: ToolMessage): { content: string; modifiedAt?: string } => {
  const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return JSON.parse(raw) as { content: string; modifiedAt?: string };
};

describe('read_file dedup durability via LangGraph checkpointer', () => {
  it('hydrates _recentReads from the checkpoint across a simulated process restart', async () => {
    const checkpointer = new MemorySaver();
    const threadId = 'durability-thread-1';
    const modifiedAt = '2026-05-13T12:00:00.000Z';
    const fingerprint = buildReadFingerprint({ targetFile: 'shared/index.ts' });
    const config = { configurable: { thread_id: threadId } };

    // -------- Agent A (turn 1) --------
    const turn1RpcService = buildChatRpcService(modifiedAt);

    const agentA = createAgent({
      model: new ScriptedToolModel('tc-turn1'),
      tools: [readFileTool],
      checkpointer,
      middleware: [createReadDedupStateMiddleware()],
    });

    await agentA.invoke(
      { messages: [new HumanMessage('Read shared/index.ts please.')] },
      {
        ...config,
        configurable: {
          ...config.configurable,
          chatRpcService: turn1RpcService,
        },
        recursionLimit: 5,
      },
    );

    const turn1Snapshot = await snapshotValues(agentA, config);
    const turn1RecentReads = turn1Snapshot._recentReads ?? {};
    expect(turn1RecentReads[fingerprint], `expected _recentReads entry for ${fingerprint} after turn 1`).toEqual({
      priorToolCallId: 'tc-turn1',
      modifiedAt,
    });

    expect(turn1RpcService.sendRpcRequest).toHaveBeenCalledTimes(1);

    const turn1ToolMessage = findReadFileToolMessage(turn1Snapshot.messages);
    const turn1Parsed = parseToolMessage(turn1ToolMessage);
    expect(
      turn1Parsed.content.startsWith('   1\t'),
      'turn 1 must surface the gutter-formatted file body (cache miss)',
    ).toBe(true);
    expect(fileUnchangedMarker.matches(turn1Parsed.content)).toBe(false);

    // -------- Simulated process restart (drop agent A entirely) --------
    // Build agent B from scratch — different middleware instance, different
    // tool runtime closures, different model instance — but reuse the SAME
    // MemorySaver to mirror Postgres-backed cross-instance hydration.
    const turn2RpcService = buildChatRpcService(modifiedAt);

    const agentB = createAgent({
      model: new ScriptedToolModel('tc-turn2'),
      tools: [readFileTool],
      checkpointer,
      middleware: [createReadDedupStateMiddleware()],
    });

    await agentB.invoke(
      { messages: [new HumanMessage('Read shared/index.ts again.')] },
      {
        ...config,
        configurable: {
          ...config.configurable,
          chatRpcService: turn2RpcService,
        },
        recursionLimit: 5,
      },
    );

    const turn2Snapshot = await snapshotValues(agentB, config);
    const turn2Messages = turn2Snapshot.messages;

    // The most recent read_file ToolMessage must be the dedup hit.
    const turn2ToolMessage = [...turn2Messages]
      .reverse()
      .find((message) => message instanceof ToolMessage && message.name === toolName.readFile);
    expect(turn2ToolMessage, 'turn 2 must produce a fresh read_file ToolMessage').toBeInstanceOf(ToolMessage);
    const turn2Parsed = parseToolMessage(turn2ToolMessage as ToolMessage);
    expect(
      fileUnchangedMarker.matches(turn2Parsed.content),
      'turn 2 must short-circuit via fileUnchangedMarker because _recentReads survived the restart',
    ).toBe(true);
    expect(turn2Parsed.content).toContain('tc-turn1');

    expect(turn2RpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
  });

  it('forces a fresh read when modifiedAt drifts between turns (mtime invalidation)', async () => {
    const checkpointer = new MemorySaver();
    const threadId = 'durability-thread-mtime';
    const fingerprint = buildReadFingerprint({ targetFile: 'shared/index.ts' });
    const config = { configurable: { thread_id: threadId } };

    const agentA = createAgent({
      model: new ScriptedToolModel('tc-original'),
      tools: [readFileTool],
      checkpointer,
      middleware: [createReadDedupStateMiddleware()],
    });

    const turn1RpcService = buildChatRpcService('2026-05-13T12:00:00.000Z');
    await agentA.invoke(
      { messages: [new HumanMessage('first read')] },
      { ...config, configurable: { ...config.configurable, chatRpcService: turn1RpcService }, recursionLimit: 5 },
    );

    const turn1Snapshot = await snapshotValues(agentA, config);
    const turn1RecentReads = turn1Snapshot._recentReads ?? {};
    expect(turn1RecentReads[fingerprint]?.modifiedAt).toBe('2026-05-13T12:00:00.000Z');

    // Simulated restart + the file moved underneath us (mtime drift).
    const agentB = createAgent({
      model: new ScriptedToolModel('tc-after-drift'),
      tools: [readFileTool],
      checkpointer,
      middleware: [createReadDedupStateMiddleware()],
    });

    const turn2RpcService = buildChatRpcService('2026-05-13T13:00:00.000Z');
    await agentB.invoke(
      { messages: [new HumanMessage('re-read after drift')] },
      { ...config, configurable: { ...config.configurable, chatRpcService: turn2RpcService }, recursionLimit: 5 },
    );

    const turn2Snapshot = await snapshotValues(agentB, config);
    const turn2RecentReads = turn2Snapshot._recentReads ?? {};
    expect(turn2RecentReads[fingerprint]).toEqual({
      priorToolCallId: 'tc-after-drift',
      modifiedAt: '2026-05-13T13:00:00.000Z',
    });

    const turn2ToolMessage = [...turn2Snapshot.messages]
      .reverse()
      .find((message) => message instanceof ToolMessage && message.name === toolName.readFile) as ToolMessage;
    const turn2Parsed = parseToolMessage(turn2ToolMessage);
    expect(
      fileUnchangedMarker.matches(turn2Parsed.content),
      'turn 2 must NOT short-circuit when modifiedAt drifted',
    ).toBe(false);

    // Both turns hit the RPC (no cache hit on either run).
    vi.clearAllMocks();
  });
});
