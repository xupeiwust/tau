import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { readFileInputSchema, rpcClientErrorCode } from '@taucad/chat';
import { assertRpcSuccess } from '@taucad/chat/utils';
import type { ChatTool, ReadFileInput, ReadFileOutput } from '@taucad/chat';
import { rpcName, toolName, fileUnchangedMarker } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';
import type { RecentReadsState } from '#api/chat/state/recent-reads-state.js';
import { buildReadFingerprint } from '#api/chat/state/recent-reads-state.js';

/**
 * `cat -n` gutter for LLM display only (mirrors claude-code's FileReadTool).
 * RPC `readFile` returns raw bytes; the chat tool adds this prefix.
 */
const formatReadFileOutputForDisplay = (rawContent: string, startLine: number): string => {
  const lines = rawContent.split('\n');
  return lines.map((line, index) => `   ${startLine + index}\t${line}`).join('\n');
};

export const readFileToolDefinition = {
  name: toolName.readFile,
  description: `Read the contents of a file from the project filesystem.

You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.

Lines in the output are prefixed with a cat -n gutter ("   <line>\\t<content>"). Files >2000 lines require explicit \`offset\` and \`limit\`.

Use this tool when you need to:
- Examine the contents of a specific file
- Understand existing code before making modifications
- Review configuration files or documentation`,
  schema: readFileInputSchema,
} as const;

/**
 * The tool function returns `Command` (a `DirectToolOutput`) so the dedup
 * pointer for `read_file` can be persisted to the LangGraph checkpoint
 * atomically with the emitted `ToolMessage`. The `ChatTool` annotation
 * keeps downstream consumers (`tool.service.ts` typing, UI message
 * shape) unaware of that internal detail; the cast is the single seam.
 */
export const readFileTool: ChatTool<
  typeof readFileInputSchema,
  ReadFileInput,
  ReadFileOutput,
  typeof toolName.readFile
> = tool(async (args, runtime: ToolRuntime<RecentReadsState>) => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const result = await chatRpcService.sendRpcRequest({
    chatId,
    toolCallId,
    rpcName: rpcName.readFile,
    args,
  });

  assertRpcSuccess(result, {
    toolName: toolName.readFile,
    toolCallId,
    clientErrorMessage(error) {
      if (error.errorCode === rpcClientErrorCode.fileNotFound) {
        return `File not found: ${args.targetFile}`;
      }

      return `Cannot read file "${args.targetFile}"`;
    },
  });

  const fingerprint = buildReadFingerprint({
    targetFile: args.targetFile,
    offset: args.offset,
    limit: args.limit,
  });
  const prior = result.modifiedAt ? runtime.state._recentReads[fingerprint] : undefined;

  if (prior && result.modifiedAt && prior.modifiedAt === result.modifiedAt) {
    const hitOutput: ReadFileOutput = {
      content: fileUnchangedMarker.build(prior.priorToolCallId),
      totalLines: result.totalLines,
      modifiedAt: result.modifiedAt,
    };

    return new Command({
      update: {
        messages: [
          new ToolMessage({
            content: JSON.stringify(hitOutput),
            // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
            tool_call_id: toolCallId,
            name: toolName.readFile,
            status: 'success',
          }),
        ],
      },
    });
  }

  const displayStartLine = result.startLine ?? args.offset ?? 1;
  const missOutput: ReadFileOutput = {
    content: formatReadFileOutputForDisplay(result.content, displayStartLine),
    totalLines: result.totalLines,
    ...(result.modifiedAt !== undefined && { modifiedAt: result.modifiedAt }),
  };

  const messageUpdate = [
    new ToolMessage({
      content: JSON.stringify(missOutput),
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
      tool_call_id: toolCallId,
      name: toolName.readFile,
      status: 'success',
    }),
  ];

  if (!result.modifiedAt) {
    return new Command({
      update: {
        messages: messageUpdate,
      },
    });
  }

  return new Command({
    update: {
      messages: messageUpdate,
      _recentReads: {
        [fingerprint]: { priorToolCallId: toolCallId, modifiedAt: result.modifiedAt },
      },
    },
  });
}, readFileToolDefinition) as unknown as ChatTool<
  typeof readFileInputSchema,
  ReadFileInput,
  ReadFileOutput,
  typeof toolName.readFile
>;
