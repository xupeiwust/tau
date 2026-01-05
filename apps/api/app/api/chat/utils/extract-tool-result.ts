import type { BaseMessageLike } from '@langchain/core/messages';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

/**
 * Represents a single tool result with its metadata.
 * The result is always stringified because Anthropic expects tool result
 * content to be a string, not a raw object.
 */
export type ToolResult = {
  toolCallId: string;
  toolName: string;
  result: string;
};

/**
 * Extracts ALL tool results from the last AI message's tool calls.
 * This supports the "all-or-nothing" batch pattern for LangGraph interrupts.
 *
 * @param messages - Array of Langchain messages after conversion
 * @returns Array of tool results, one for each tool call in the last AI message
 * @throws Error if messages array is empty or no tool calls found
 */
export function extractAllToolResults(messages: BaseMessageLike[]): ToolResult[] {
  if (messages.length === 0) {
    throw new Error('Messages array cannot be empty');
  }

  // Find the last AIMessage with tool calls
  const lastAiMessageWithTools = messages.findLast((message): message is AIMessage => {
    return message instanceof AIMessage && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  });

  if (!lastAiMessageWithTools?.tool_calls) {
    throw new Error('No tool calls found in messages');
  }

  const results: ToolResult[] = [];

  for (const toolCall of lastAiMessageWithTools.tool_calls) {
    if (!toolCall.id) {
      throw new Error('Tool call has no ID');
    }

    // Find the corresponding ToolMessage with the result
    const toolMessage = messages.find((message): message is ToolMessage => {
      return message instanceof ToolMessage && message.tool_call_id === toolCall.id;
    });

    if (!toolMessage) {
      throw new Error(`No tool result found for tool call: ${toolCall.id}`);
    }

    // Parse the JSON content to get the actual result
    const content = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content);

    try {
      const parsedContent: unknown = JSON.parse(content);

      // Unwrap AI SDK wrapper format {type: "json"|"text", value: ...}
      // The AI SDK wraps all tool outputs in this format, but LangGraph/Anthropic
      // expects the raw value
      let unwrappedResult: unknown;

      if (
        parsedContent !== null &&
        typeof parsedContent === 'object' &&
        'type' in parsedContent &&
        'value' in parsedContent
      ) {
        // AI SDK wrapper detected - extract the inner value
        const wrapper = parsedContent as { type: string; value: unknown };
        unwrappedResult = wrapper.value;
      } else {
        // No wrapper - use as-is
        unwrappedResult = parsedContent;
      }

      // Ensure we don't push undefined - convert to null for JSON compatibility
      const finalResult = unwrappedResult === undefined ? null : unwrappedResult;

      // CRITICAL: Anthropic expects tool result content to be a STRING, not an object.
      // If we pass raw objects like {content: "...", totalLines: 40}, Anthropic's
      // _formatContent will try to treat them as content blocks and fail because
      // they don't have a 'type' field. We must stringify the result.
      const stringifiedResult = JSON.stringify(finalResult);

      results.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: stringifiedResult,
      });
    } catch (error) {
      throw new Error(`Failed to parse tool result for ${toolCall.id}: ${String(error)}`);
    }
  }

  return results;
}

/**
 * Extracts all tool results, returning undefined if not found (non-throwing version)
 * @param messages - Array of Langchain messages after conversion
 * @returns Array of tool results, or undefined if no tool calls found
 */
export function tryExtractAllToolResults(messages: BaseMessageLike[]): ToolResult[] | undefined {
  try {
    return extractAllToolResults(messages);
  } catch {
    return undefined;
  }
}

/**
 * Extracts the result from the last tool call in the Langchain messages array
 * @param messages - Array of Langchain messages after conversion
 * @returns The result from the last tool invocation, or undefined if no tool calls found
 * @throws Error if messages array is empty or malformed
 */
export function extractLastToolResult(messages: BaseMessageLike[]): unknown {
  if (messages.length === 0) {
    throw new Error('Messages array cannot be empty');
  }

  // Find the last AIMessage with tool calls
  const lastAiMessageWithTools = messages.findLast((message): message is AIMessage => {
    return message instanceof AIMessage && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  });

  if (!lastAiMessageWithTools?.tool_calls) {
    throw new Error('No tool calls found in messages');
  }

  // Get the last tool call (by array position, as they're ordered)
  const lastToolCall = lastAiMessageWithTools.tool_calls.at(-1);

  if (!lastToolCall?.id) {
    throw new Error('Last tool call has no ID');
  }

  // Find the corresponding ToolMessage with the result
  const toolMessage = messages.find((message): message is ToolMessage => {
    return message instanceof ToolMessage && message.tool_call_id === lastToolCall.id;
  });

  if (!toolMessage) {
    throw new Error('No tool result found for the last tool call');
  }

  // Parse the JSON content to get the actual result
  // ToolMessage.content is always a string in our conversion logic
  const content = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content);

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse tool result: ${String(error)}`);
  }
}

/**
 * Extracts the result from the last tool call, returning undefined if not found (non-throwing version)
 * @param messages - Array of Langchain messages after conversion
 * @returns The result from the last tool invocation, or undefined if no tool calls found
 */
export function tryExtractLastToolResult(messages: BaseMessageLike[]): unknown {
  try {
    return extractLastToolResult(messages);
  } catch {
    return undefined;
  }
}
