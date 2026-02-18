import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ChatRpcService } from '#api/chat/chat-rpc.service.js';

// Mock the dependencies
vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => 'req_test123'),
}));

vi.mock('@taucad/chat', () => ({
  rpcSchemasRegistry: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Tool name uses snake_case
    read_file: {
      inputSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
      resultSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
    },
  },
}));

describe('ChatRpcService', () => {
  let service: ChatRpcService;

  beforeEach(() => {
    service = new ChatRpcService();
  });

  describe('sendRpcRequest', () => {
    it('should return NO_CONNECTION RPC error when no socket is registered', async () => {
      const result = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual({
        errorCode: 'NO_CONNECTION',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest assertion
        message: expect.stringContaining('No WebSocket connection to the browser'),
        rpcName: 'read_file',
      });
    });

    it('should return NO_CONNECTION RPC error when socket is disconnected', async () => {
      const mockSocket = {
        id: 'socket_123',
        connected: false,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      const result = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual({
        errorCode: 'NO_CONNECTION',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest assertion
        message: expect.stringContaining('No WebSocket connection to the browser'),
        rpcName: 'read_file',
      });
    });

    it('should include rpcName in error metadata', async () => {
      const result = await service.sendRpcRequest('chat_456', 'call_2', 'read_file', {
        targetFile: 'another.txt',
      });

      expect(result).toMatchObject({
        errorCode: 'NO_CONNECTION',
        rpcName: 'read_file',
      });
    });
  });

  describe('registerConnection', () => {
    it('should register a socket connection without throwing', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
      } as unknown as Socket;

      expect(() => {
        service.registerConnection('chat_123', mockSocket);
      }).not.toThrow();
    });
  });

  describe('isConnected', () => {
    it('should return false when no socket is registered', () => {
      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return false when socket is disconnected', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: false,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return true when socket is connected', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      expect(service.isConnected('chat_123')).toBe(true);
    });
  });

  describe('registerAbortSignal', () => {
    it('should add chatId to abortedChats when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      service.registerAbortSignal('chat_123', controller.signal);

      // SendRpcRequest should reject immediately for an aborted chat
      const result = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
        rpcName: 'read_file',
      });
    });

    it('should clean up abortedChats entry after delay for early-aborted signal', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      controller.abort();

      service.registerAbortSignal('chat_123', controller.signal);

      // Should be blocked immediately
      const resultBeforeCleanup = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(resultBeforeCleanup).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
      });

      // Advance past the 5s cleanup window
      vi.advanceTimersByTime(5000);

      // Register a connected socket so we don't get NO_CONNECTION
      const mockSocket = {
        id: 'socket_123',
        connected: true,
        emit: vi.fn(),
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      // Should no longer be blocked — sendRpcRequest will proceed (emit to socket)
      void service.sendRpcRequest('chat_123', 'call_2', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));

      vi.useRealTimers();
    });

    it('should clear stale abort entry when a new signal is registered for the same chat', async () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
        emit: vi.fn(),
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      // Abort request A
      const controllerA = new AbortController();
      service.registerAbortSignal('chat_123', controllerA.signal);
      controllerA.abort();

      // ChatId should now be in abortedChats — verify RPCs are blocked
      const blockedResult = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(blockedResult).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
      });

      // Register request B (new signal for the same chatId) — should clear stale entry
      const controllerB = new AbortController();
      service.registerAbortSignal('chat_123', controllerB.signal);

      // RPCs should now work again
      void service.sendRpcRequest('chat_123', 'call_2', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));
    });

    it('should reject RPCs after abort and accept them after re-registration', async () => {
      vi.useFakeTimers();
      const mockSocket = {
        id: 'socket_123',
        connected: true,
        emit: vi.fn(),
      } as unknown as Socket;
      service.registerConnection('chat_123', mockSocket);

      // Start request A and abort it
      const controllerA = new AbortController();
      service.registerAbortSignal('chat_123', controllerA.signal);
      controllerA.abort();

      // RPCs are blocked
      const blockedResult = await service.sendRpcRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(blockedResult).toMatchObject({
        errorCode: 'CLIENT_DISCONNECTED',
      });

      // Immediately start request B (within 5s window)
      const controllerB = new AbortController();
      service.registerAbortSignal('chat_123', controllerB.signal);

      // RPCs should work now despite being within the 5s cleanup window
      void service.sendRpcRequest('chat_123', 'call_2', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('rpc_request', expect.objectContaining({ rpcName: 'read_file' }));

      vi.useRealTimers();
    });
  });
});
