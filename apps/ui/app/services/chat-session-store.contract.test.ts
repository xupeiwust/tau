// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Chat } from '@ai-sdk/react';

/**
 * Contract test for the resumable-chat-streams continuation path.
 *
 * `chat-session-store.ts` resumes interrupted streams by calling AI SDK's
 * private `Chat.makeRequest({ trigger: 'submit-message' })` -- the same
 * code path that `sendMessage`/`regenerate`/`resumeStream` use internally,
 * minus the message-mutation step. AI SDK ships `makeRequest` as `private`
 * so a direct property reference is rejected at TS compile time, but the
 * method exists on every runtime instance.
 *
 * If AI SDK ever renames or removes `makeRequest`, this assertion fails
 * loudly and points the maintainer at:
 *   - apps/ui/app/services/chat-session-store.ts (case 'continue')
 *   - apps/ui/app/hooks/chat-persistence.machine.ts (`{ kind: 'continue' }`)
 *   - docs/research/resumable-chat-streams.md (R1 implementation notes)
 *
 * See `node_modules/.pnpm/ai@<version>/.../ai/src/ui/chat.ts` for the
 * canonical declaration. Pinned to `ai@6.0.x` for now.
 */
describe('AI SDK private API contract', () => {
  it('Chat.prototype carries a `makeRequest` method', () => {
    const proto = Chat.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['makeRequest']).toBe('function');
  });

  it('Chat instance carries a callable `makeRequest`', () => {
    const instance = new Chat({ id: 'chat_contract_test' });
    const callable = (instance as unknown as { makeRequest: unknown }).makeRequest;
    expect(typeof callable).toBe('function');
  });

  it('`makeRequest({ trigger: "submit-message" })` returns a Promise without throwing synchronously', async () => {
    const instance = new Chat({ id: 'chat_contract_test' });
    const callable = (instance as unknown as { makeRequest: (args: { trigger: 'submit-message' }) => Promise<void> })
      .makeRequest;
    // Synchronous assertion only -- the call dispatches against a stub
    // transport so the returned promise is allowed to reject (no transport
    // configured); we only need the method to exist + accept the arg shape.
    let result: Promise<void> | undefined;
    expect(() => {
      result = callable.call(instance, { trigger: 'submit-message' });
    }).not.toThrow();
    expect(result).toBeInstanceOf(Promise);
    // Drain the promise so the test runner doesn't see an unhandled rejection.
    try {
      await result;
    } catch {
      // Network/transport rejection is expected in the contract harness.
    }
  });
});
