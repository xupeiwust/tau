// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { fileUnchangedMarker, rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';
import { readFileToolDefinition, readFileTool } from '#api/tools/tools/tool-read-file.js';
import type { RecentReadsState } from '#api/chat/state/recent-reads-state.js';
import { buildReadFingerprint } from '#api/chat/state/recent-reads-state.js';

describe('readFileToolDefinition', () => {
  describe('tool description', () => {
    it('should advertise the cat -n gutter output format', () => {
      expect(readFileToolDefinition.description).toMatch(/cat -n gutter/);
    });

    it('should direct the agent to provide offset/limit for files >2000 lines', () => {
      expect(readFileToolDefinition.description).toMatch(/Files >2000 lines/);
      expect(readFileToolDefinition.description).toMatch(/`offset`/);
      expect(readFileToolDefinition.description).toMatch(/`limit`/);
    });
  });
});

type ToolInvoke = {
  invoke(
    input: { targetFile: string; offset?: number; limit?: number },
    runtime: ToolRuntime<RecentReadsState>,
  ): Promise<unknown>;
};

const buildRuntime = (
  toolCallId: string,
  chatRpcService: ChatRpcConfigurable['chatRpcService'],
  recentReads: RecentReadsState['_recentReads'] = {},
): ToolRuntime<RecentReadsState> =>
  ({
    toolCallId,
    state: { _recentReads: recentReads },
    configurable: {
      chatRpcService,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- ChatRpcConfigurable uses LangGraph thread_id
      thread_id: 'chat-invocation-test',
    },
  }) as unknown as ToolRuntime<RecentReadsState>;

const expectCommand = (value: unknown): Command => {
  expect(value).toBeInstanceOf(Command);
  return value as Command;
};

const expectToolMessage = (value: unknown): ToolMessage => {
  expect(value).toBeInstanceOf(ToolMessage);
  return value as ToolMessage;
};

const parseToolMessageContent = (message: ToolMessage): { content: string; totalLines: number; modifiedAt?: string } =>
  JSON.parse(typeof message.content === 'string' ? message.content : '') as {
    content: string;
    totalLines: number;
    modifiedAt?: string;
  };

describe('readFileTool — gutter wrap and dedup', () => {
  it('returns a Command whose ToolMessage contains the cat -n gutter on a fresh read', async () => {
    const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
    chatRpcService.sendRpcRequest.mockResolvedValue({
      success: true,
      content: 'line1\nline2',
      totalLines: 3,
      startLine: 1,
      modifiedAt: '2026-05-13T12:00:00.000Z',
    });

    const runtime = buildRuntime('tc-wrap', chatRpcService);
    const tool = readFileTool as unknown as ToolInvoke;
    const result = await tool.invoke({ targetFile: 'f.ts' }, runtime);

    const command = expectCommand(result);
    const update = command.update as {
      messages: ToolMessage[];
      _recentReads?: Record<string, { priorToolCallId: string; modifiedAt: string }>;
    };
    expect(update.messages).toHaveLength(1);
    const message = expectToolMessage(update.messages[0]);
    expect(parseToolMessageContent(message).content).toBe('   1\tline1\n   2\tline2');

    const fingerprint = buildReadFingerprint({ targetFile: 'f.ts' });
    expect(update._recentReads).toEqual({
      [fingerprint]: { priorToolCallId: 'tc-wrap', modifiedAt: '2026-05-13T12:00:00.000Z' },
    });
  });

  it('aligns the gutter with startLine when an offset slice is returned', async () => {
    const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
    chatRpcService.sendRpcRequest.mockResolvedValue({
      success: true,
      content: 'gamma\ndelta',
      totalLines: 10,
      startLine: 3,
      modifiedAt: '2026-05-13T12:00:00.000Z',
    });

    const runtime = buildRuntime('tc-offset', chatRpcService);
    const tool = readFileTool as unknown as ToolInvoke;
    const result = await tool.invoke({ targetFile: 'f.ts', offset: 3, limit: 2 }, runtime);

    const command = expectCommand(result);
    const update = command.update as { messages: ToolMessage[] };
    const message = expectToolMessage(update.messages[0]);
    expect(parseToolMessageContent(message).content).toBe('   3\tgamma\n   4\tdelta');
  });

  it('returns the fileUnchangedMarker without _recentReads churn when fingerprint dedup hits', async () => {
    const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
    const modifiedAt = '2026-05-13T12:00:00.000Z';
    chatRpcService.sendRpcRequest.mockResolvedValue({
      success: true,
      content: 'only',
      totalLines: 1,
      startLine: 1,
      modifiedAt,
    });

    const fingerprint = buildReadFingerprint({ targetFile: 'same.ts' });
    const runtime = buildRuntime('tc-second', chatRpcService, {
      [fingerprint]: { priorToolCallId: 'tc-first', modifiedAt },
    });

    const tool = readFileTool as unknown as ToolInvoke;
    const result = await tool.invoke({ targetFile: 'same.ts' }, runtime);

    const command = expectCommand(result);
    const update = command.update as { messages: ToolMessage[]; _recentReads?: unknown };
    const message = expectToolMessage(update.messages[0]);
    const parsed = parseToolMessageContent(message);

    expect(parsed.content).toBe(fileUnchangedMarker.build('tc-first'));
    expect(fileUnchangedMarker.matches(parsed.content)).toBe(true);
    expect(update._recentReads).toBeUndefined();
    expect(message.name).toBe(toolName.readFile);

    expect(chatRpcService.sendRpcRequest).toHaveBeenCalledWith(expect.objectContaining({ rpcName: rpcName.readFile }));
  });

  it('does not emit a _recentReads delta when the RPC response has no modifiedAt', async () => {
    const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
    chatRpcService.sendRpcRequest.mockResolvedValue({
      success: true,
      content: 'no-mtime',
      totalLines: 1,
      startLine: 1,
    });

    const runtime = buildRuntime('tc-no-mtime', chatRpcService);
    const tool = readFileTool as unknown as ToolInvoke;
    const result = await tool.invoke({ targetFile: 'no-mtime.ts' }, runtime);

    const command = expectCommand(result);
    const update = command.update as { messages: ToolMessage[]; _recentReads?: unknown };
    expect(update._recentReads).toBeUndefined();
    expect(update.messages).toHaveLength(1);
  });

  it('treats a stale dedup pointer (mtime drift) as a miss and emits a fresh delta', async () => {
    const chatRpcService = mock<ChatRpcConfigurable['chatRpcService']>();
    chatRpcService.sendRpcRequest.mockResolvedValue({
      success: true,
      content: 'drifted',
      totalLines: 1,
      startLine: 1,
      modifiedAt: '2026-05-13T13:00:00.000Z',
    });

    const fingerprint = buildReadFingerprint({ targetFile: 'drift.ts' });
    const runtime = buildRuntime('tc-drift', chatRpcService, {
      [fingerprint]: { priorToolCallId: 'tc-prev', modifiedAt: '2026-05-13T12:00:00.000Z' },
    });

    const tool = readFileTool as unknown as ToolInvoke;
    const result = await tool.invoke({ targetFile: 'drift.ts' }, runtime);

    const command = expectCommand(result);
    const update = command.update as {
      messages: ToolMessage[];
      _recentReads?: Record<string, { priorToolCallId: string; modifiedAt: string }>;
    };
    expect(update._recentReads).toEqual({
      [fingerprint]: { priorToolCallId: 'tc-drift', modifiedAt: '2026-05-13T13:00:00.000Z' },
    });
    const message = expectToolMessage(update.messages[0]);
    expect(parseToolMessageContent(message).content).toBe('   1\tdrifted');
  });
});
