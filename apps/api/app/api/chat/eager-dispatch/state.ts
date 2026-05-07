import type { Command } from '@langchain/langgraph';
import type { ToolMessage } from '@langchain/core/messages';

/**
 * Tracks one eagerly-dispatched tool call for wrapToolCall short-circuiting.
 *
 * Internal state stays bound to one {@link EagerToolDispatchHandler} instance —
 * recreated per streaming request in {@link apps/api/app/api/chat/chat.controller.ts}.
 */
export type EagerToolEntry = {
  toolCallId: string;
  toolName: string;
  invokePromise: Promise<ToolMessage | Command | undefined>;
  result?: ToolMessage | Command;
};
