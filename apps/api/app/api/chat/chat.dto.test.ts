import { describe, expect, it } from 'vitest';
import type { MyUIMessage } from '@taucad/chat';
import { createChatSchema } from '#api/chat/chat.dto.js';

const validUserMessage: MyUIMessage = {
  id: 'msg_1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  metadata: {
    model: 'openai-gpt-5.5',
    kernel: 'replicad',
    mode: 'agent',
    toolChoice: 'auto',
    testingEnabled: true,
  },
};

const baseValidBody = {
  id: 'chat_1',
  messages: [validUserMessage],
};

function expectIssueAtPath(
  issues: ReadonlyArray<{ path: readonly PropertyKey[] }>,
  pathSuffix: readonly PropertyKey[],
): void {
  const matched = issues.some((issue) =>
    pathSuffix.every((segment, offset) => issue.path[issue.path.length - pathSuffix.length + offset] === segment),
  );
  expect(matched, `expected an issue at path suffix [${pathSuffix.join(', ')}] but saw ${JSON.stringify(issues)}`).toBe(
    true,
  );
}

describe('createChatSchema', () => {
  describe('happy path', () => {
    it('accepts a request whose last user message has all required metadata fields', () => {
      const result = createChatSchema.safeParse(baseValidBody);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues, null, 2)).toBe(true);
    });
  });

  describe('last-user-message contract', () => {
    it('rejects when the last message is not a user message', () => {
      const assistantTrailingBody = {
        id: 'chat_assistant_trailing',
        messages: [
          validUserMessage,
          {
            id: 'msg_assistant',
            role: 'assistant',
            parts: [{ type: 'text', text: 'reply' }],
          } satisfies MyUIMessage,
        ],
      };

      const result = createChatSchema.safeParse(assistantTrailingBody);
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expectIssueAtPath(result.error.issues, ['messages', 1, 'role']);
      expect(result.error.issues.some((issue) => /last message.*user/i.test(issue.message))).toBe(true);
    });
  });

  describe('required metadata fields on the last user message', () => {
    const requiredFields = ['kernel', 'model', 'mode', 'toolChoice', 'testingEnabled'] as const;

    for (const field of requiredFields) {
      it(`rejects when metadata.${field} is missing`, () => {
        const { [field]: _omitted, ...remainingMetadata } = validUserMessage.metadata!;
        const body = {
          ...baseValidBody,
          messages: [
            {
              ...validUserMessage,
              metadata: remainingMetadata,
            },
          ],
        };
        const result = createChatSchema.safeParse(body);
        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }
        expectIssueAtPath(result.error.issues, ['metadata', field]);
      });
    }

    it('rejects when metadata is entirely missing on the last user message', () => {
      const { metadata: _omitted, ...messageWithoutMetadata } = validUserMessage;
      const body = {
        ...baseValidBody,
        messages: [messageWithoutMetadata],
      };
      const result = createChatSchema.safeParse(body);
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      for (const field of requiredFields) {
        expectIssueAtPath(result.error.issues, ['metadata', field]);
      }
    });

    it('rejects when metadata.kernel is not a known kernel provider', () => {
      const body = {
        ...baseValidBody,
        messages: [
          {
            ...validUserMessage,
            metadata: { ...validUserMessage.metadata!, kernel: 'not-a-real-kernel' },
          },
        ],
      };
      const result = createChatSchema.safeParse(body);
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expectIssueAtPath(result.error.issues, ['metadata', 'kernel']);
    });
  });

  describe('historical-message permissiveness', () => {
    it('keeps non-trailing user messages permissive (kernel may be absent on historical turns)', () => {
      const historicalMessage: MyUIMessage = {
        id: 'msg_history',
        role: 'user',
        parts: [{ type: 'text', text: 'old turn' }],
        metadata: { model: 'openai-gpt-5.5' },
      };
      const assistantReply: MyUIMessage = {
        id: 'msg_history_reply',
        role: 'assistant',
        parts: [{ type: 'text', text: 'old reply' }],
      };

      const body = {
        id: 'chat_with_history',
        messages: [historicalMessage, assistantReply, validUserMessage],
      };

      const result = createChatSchema.safeParse(body);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues, null, 2)).toBe(true);
    });
  });
});
