/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { fromMemoryFS } from '#client/filesystem-constructors.js';
import { createFileSystemProxy } from '#framework/kernel-filesystem-bridge.js';
import { exposeFileSystem, createFileSystemBridge } from '#filesystem/filesystem-bridge.js';

describe('filesystem high-level wrappers', () => {
  describe('exposeFileSystem', () => {
    it('should serve a filesystem when receiving a bridge message', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/hello.txt': 'world' });

      const cleanup = exposeFileSystem(fs);

      const channel = new MessageChannel();
      const proxy = createFileSystemProxy(channel.port2);

      // Simulate a bridge message arriving at the worker global
      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'kernelBridge', port: channel.port1 },
        }),
      );

      // Allow the event loop to process the message
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const content = await proxy.readFile('/hello.txt', 'utf8');
      expect(content).toBe('world');

      cleanup();
    });

    it('should stop listening after cleanup is called', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/test.txt': 'data' });
      const cleanup = exposeFileSystem(fs);
      cleanup();

      const channel = new MessageChannel();
      // Post a message after cleanup -- no server should be set up
      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'kernelBridge', port: channel.port1 },
        }),
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      // Port1 should have no onmessage handler, so proxy calls will hang
      // We verify by checking port1.onmessage is null
      expect(channel.port1.onmessage).toBeNull();
    });

    it('should support custom messageType', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/custom.txt': 'custom' });
      const cleanup = exposeFileSystem(fs, { messageType: 'myBridge' });

      const channel = new MessageChannel();

      // Default type should be ignored
      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'kernelBridge', port: channel.port1 },
        }),
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      expect(channel.port1.onmessage).toBeNull();

      // Custom type should work
      const channel2 = new MessageChannel();
      const proxy2 = createFileSystemProxy(channel2.port2);

      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'myBridge', port: channel2.port1 },
        }),
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const content = await proxy2.readFile('/custom.txt', 'utf8');
      expect(content).toBe('custom');

      cleanup();
    });
  });

  describe('createFileSystemBridge', () => {
    it('should post a message with port to the worker', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = { postMessage: postMessageSpy } as unknown as Worker;

      const port = createFileSystemBridge(mockWorker);

      expect(port).toBeInstanceOf(MessagePort);
      expect(postMessageSpy).toHaveBeenCalledOnce();

      const [message, transferables] = postMessageSpy.mock.calls[0] as [
        { type: string; port: MessagePort },
        MessagePort[],
      ];
      expect(message.type).toBe('kernelBridge');
      expect(message.port).toBeInstanceOf(MessagePort);
      expect(transferables).toHaveLength(1);
      expect(transferables[0]).toBe(message.port);
    });

    it('should support custom messageType', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = { postMessage: postMessageSpy } as unknown as Worker;

      createFileSystemBridge(mockWorker, { messageType: 'customBridge' });

      const [message] = postMessageSpy.mock.calls[0] as [{ type: string; port: MessagePort }];
      expect(message.type).toBe('customBridge');
    });

    it('should return a different port than the one transferred', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = { postMessage: postMessageSpy } as unknown as Worker;

      const returnedPort = createFileSystemBridge(mockWorker);

      const [message] = postMessageSpy.mock.calls[0] as [{ type: string; port: MessagePort }];
      expect(returnedPort).not.toBe(message.port);
    });
  });
});
