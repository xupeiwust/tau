import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatToolsService } from '#api/chat/chat-tools.service.js';

// Mock the dependencies
vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => 'req_test123'),
}));

vi.mock('@taucad/chat', () => ({
  toolSchemasRegistry: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Tool name uses snake_case
    read_file: {
      inputSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
      outputSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
    },
  },
}));

describe('ChatToolsService', () => {
  let service: ChatToolsService;

  beforeEach(() => {
    service = new ChatToolsService();
  });

  describe('connection failure tracking', () => {
    it('should return NO_CLIENT_CONNECTION error with attempt 1/3 on first failure', async () => {
      const result = await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual(
        expect.objectContaining({
          errorCode: 'NO_CLIENT_CONNECTION',
          message: expect.stringContaining('(attempt 1/3)'),
        }),
      );
    });

    it('should return NO_CLIENT_CONNECTION error with attempt 2/3 on second failure', async () => {
      // First failure
      await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', { targetFile: 'test.txt' });

      // Second failure
      const result = await service.sendToolCallRequest('chat_123', 'call_2', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual(
        expect.objectContaining({
          errorCode: 'NO_CLIENT_CONNECTION',
          message: expect.stringContaining('(attempt 2/3)'),
        }),
      );
    });

    it('should return NO_CLIENT_CONNECTION error with do not retry message on third failure', async () => {
      // First failure
      await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', { targetFile: 'test.txt' });

      // Second failure
      await service.sendToolCallRequest('chat_123', 'call_2', 'read_file', { targetFile: 'test.txt' });

      // Third failure
      const result = await service.sendToolCallRequest('chat_123', 'call_3', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual(
        expect.objectContaining({
          errorCode: 'NO_CLIENT_CONNECTION',
          message: expect.stringContaining('(attempt 3/3)'),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('Retrying will not help'),
        }),
      );
    });

    it('should track failures independently per chatId', async () => {
      // Two failures for chat_123
      await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', { targetFile: 'test.txt' });
      await service.sendToolCallRequest('chat_123', 'call_2', 'read_file', { targetFile: 'test.txt' });

      // First failure for chat_456 - should show attempt 1/3
      const result = await service.sendToolCallRequest('chat_456', 'call_1', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual(
        expect.objectContaining({
          errorCode: 'NO_CLIENT_CONNECTION',
          message: expect.stringContaining('(attempt 1/3)'),
        }),
      );
    });

    it('should reset failure count when connection is registered', async () => {
      // Two failures
      await service.sendToolCallRequest('chat_123', 'call_1', 'read_file', { targetFile: 'test.txt' });
      await service.sendToolCallRequest('chat_123', 'call_2', 'read_file', { targetFile: 'test.txt' });

      // Register a connection (simulating reconnection)
      const mockSocket = {
        id: 'socket_123',
        connected: false, // Still disconnected for the test
      } as unknown as import('socket.io').Socket;
      service.registerConnection('chat_123', mockSocket);

      // Next failure should be counted as first (counter was reset)
      const result = await service.sendToolCallRequest('chat_123', 'call_3', 'read_file', {
        targetFile: 'test.txt',
      });

      expect(result).toEqual(
        expect.objectContaining({
          errorCode: 'NO_CLIENT_CONNECTION',
          message: expect.stringContaining('(attempt 1/3)'),
        }),
      );
    });
  });

  describe('registerConnection', () => {
    it('should reset failure count when registering connection', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
      } as unknown as import('socket.io').Socket;

      // This should not throw and should reset any existing failure count
      expect(() => service.registerConnection('chat_123', mockSocket)).not.toThrow();
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
      } as unknown as import('socket.io').Socket;
      service.registerConnection('chat_123', mockSocket);

      expect(service.isConnected('chat_123')).toBe(false);
    });

    it('should return true when socket is connected', () => {
      const mockSocket = {
        id: 'socket_123',
        connected: true,
      } as unknown as import('socket.io').Socket;
      service.registerConnection('chat_123', mockSocket);

      expect(service.isConnected('chat_123')).toBe(true);
    });
  });
});
