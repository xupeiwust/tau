import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { uiMessagesSchema, messageMetadataSchema } from '@taucad/chat';
import type { MyUIMessage } from '@taucad/chat';

export type CreateChat = {
  id: string;
  messages: MyUIMessage[];
};

/**
 * Strict metadata contract for the LAST user message in a chat request — the
 * message that drives the current turn. Every agent-config field the
 * controller/service consumes must be present and well-typed; we do not fall
 * back silently on the API side. Historical messages stay validated by the
 * permissive {@link messageMetadataSchema} so old chats still deserialise.
 *
 * Required fields here are the single source of truth for the chat API's
 * "what does the agent need to run" contract. Adding a field that the agent
 * consumes must be paired with a required entry here so a missing value
 * surfaces as a Zod 400 at the body-parse boundary instead of a silent
 * default deeper in the stack.
 */
export const lastUserMessageMetadataSchema = messageMetadataSchema.required({
  kernel: true,
  model: true,
  mode: true,
  toolChoice: true,
  testingEnabled: true,
});

export const createChatSchema: z.ZodType<CreateChat> = z
  .object({
    id: z.string(),
    messages: uiMessagesSchema,
  })
  .superRefine((value, context) => {
    const lastIndex = value.messages.length - 1;
    const lastMessage = value.messages[lastIndex];
    if (!lastMessage) {
      // `uiMessagesSchema` already enforces `.nonempty()` so this is unreachable;
      // the guard exists purely so TypeScript narrows below.
      return;
    }

    if (lastMessage.role !== 'user') {
      context.addIssue({
        code: 'custom',
        path: ['messages', lastIndex, 'role'],
        message: 'The last message in a chat request must be a user message',
      });
      return;
    }

    const metadataResult = lastUserMessageMetadataSchema.safeParse(lastMessage.metadata ?? {});
    if (metadataResult.success) {
      return;
    }

    for (const issue of metadataResult.error.issues) {
      context.addIssue({
        ...issue,
        path: ['messages', lastIndex, 'metadata', ...issue.path],
      });
    }
  })
  .meta({ id: 'CreateChat' });

export class CreateChatDto extends createZodDto(createChatSchema) {}
