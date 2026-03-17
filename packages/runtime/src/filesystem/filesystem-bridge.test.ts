import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFileSystemBridge } from '#filesystem/filesystem-bridge.js';

describe('createFileSystemBridge', () => {
  const originalPostMessage = MessagePort.prototype.postMessage;
  afterEach(() => {
    MessagePort.prototype.postMessage = originalPostMessage;
  });

  it('should send disconnect message before closing port on dispose', () => {
    const messages: unknown[] = [];
    const worker = {
      postMessage: vi.fn(),
    } as unknown as Worker;

    const handle = createFileSystemBridge(worker);

    const originalPort2PostMessage = handle.port.postMessage.bind(handle.port);
    // @ts-expect-error - mock the postMessage method
    handle.port.postMessage = vi.fn((...args: Parameters<MessagePort['postMessage']>) => {
      messages.push(args[0]);
      originalPort2PostMessage(...args);
    });

    handle.dispose();

    expect(messages).toContainEqual({ type: 'disconnect' });
  });
});
