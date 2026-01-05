import { messageRole } from '@taucad/chat/constants';
import type { MyUIMessage } from '@taucad/chat';
import { useChatSelector } from '#hooks/use-chat.js';
import { ChatToolInlineLink } from '#components/chat/chat-tool-inline.js';
import { cn } from '#utils/ui.utils.js';

type ChatMessagePlanningProperties = {
  readonly messageId: string;
};

/**
 * Check if all tool parts in a message have concluded (output-available or output-error).
 * Returns true if there are no tool parts or all tool parts have completed.
 */
function areAllToolPartsConcluded(parts: MyUIMessage['parts']): boolean {
  for (const part of parts) {
    // Check if part has a state property (tool invocation parts)
    if ('state' in part && part.state !== undefined) {
      const state = part.state as string;
      // If any tool is still processing, return false
      if (state !== 'output-available' && state !== 'output-error') {
        return false;
      }
    }
  }

  return true;
}

/**
 * Displays a "Planning next moves..." indicator when the AI is processing.
 * Shows after a user message or when an assistant message has all tool parts concluded.
 */
export function ChatMessagePlanning({ messageId }: ChatMessagePlanningProperties): React.JSX.Element | undefined {
  const isStreamingOrSubmitted = useChatSelector((state) => ['submitted', 'streaming'].includes(state.status));

  const message = useChatSelector((state) => state.messagesById.get(messageId));

  const isUser = message?.role === messageRole.user;

  // Check if this is the last message and whether we should show the planning indicator
  const shouldShowPlanningIndicator = useChatSelector((state) => {
    const { messages } = state;
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      return false;
    }

    // Case 1: Last message is user message (no assistant response yet)
    if (lastMessage.role === messageRole.user) {
      return lastMessage.id === messageId;
    }

    // Case 2: Last message is assistant message with all tool parts concluded
    if (lastMessage.role === messageRole.assistant && lastMessage.id === messageId) {
      return areAllToolPartsConcluded(lastMessage.parts);
    }

    return false;
  });

  // Show "Planning next moves" when streaming/submitted and this message qualifies for the indicator
  const shouldShowPlanning = isStreamingOrSubmitted && shouldShowPlanningIndicator;

  if (!shouldShowPlanning) {
    return undefined;
  }

  return (
    <div className={cn(isUser && 'ml-4')}>
      <ChatToolInlineLink status="loading">Planning next moves...</ChatToolInlineLink>
    </div>
  );
}
