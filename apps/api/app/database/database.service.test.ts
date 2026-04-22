import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mock } from 'vitest-mock-extended';
import { getLoggerToken } from 'nestjs-pino';
import type { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '#database/database.service.js';

const { mockMigrate, mockExecute, mockEnd, mockPostgres } = vi.hoisted(() => {
  const mockMigrate = vi.fn().mockResolvedValue(undefined);
  // The probe issues `SELECT 1`; postgres returns `[{ '?column?': 1 }]` for that
  // query, so we mirror that wire-format in the canned mock value.
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Postgres unnamed-column response key
  const mockExecute = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const mockPostgres = vi.fn(() => ({ end: mockEnd }));
  return { mockMigrate, mockExecute, mockEnd, mockPostgres };
});

vi.mock('drizzle-orm/postgres-js/migrator', () => ({
  migrate: mockMigrate,
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    execute: mockExecute,
  })),
}));

vi.mock('postgres', () => ({
  default: mockPostgres,
}));

describe('DatabaseService', () => {
  let module: TestingModule;
  let service: DatabaseService;
  let logger: PinoLogger;

  const mockConfigService = {
    get: vi.fn(() => 'postgres://test:test@db.example.com:5432/test'),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Postgres unnamed-column response key
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);
    mockMigrate.mockResolvedValue(undefined);

    logger = mock<PinoLogger>({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      setContext: vi.fn(),
    });

    module = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getLoggerToken(DatabaseService.name), useValue: logger },
      ],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('onModuleInit', () => {
    it('should run the connectivity probe before migrations and emit a success log', async () => {
      await service.onModuleInit();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockMigrate).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Database connectivity probe succeeded');
      expect(logger.info).toHaveBeenCalledWith('Database service initialized');
    });

    it('should log structured probe failure with err/host/port/hint and rethrow with cause when SELECT 1 fails', async () => {
      const probeError = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:5432'), {
        code: 'ECONNREFUSED',
      });
      mockExecute.mockRejectedValueOnce(probeError);

      try {
        await service.onModuleInit();
        expect.fail('expected onModuleInit to throw');
      } catch (error) {
        expect((error as Error).message).toBe('Database connectivity probe failed');
        expect((error as Error).cause).toBe(probeError);
      }

      expect(mockMigrate).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const probeCall = vi.mocked(logger.error).mock.calls[0]!;
      const probePayload = probeCall[0] as Record<string, unknown>;
      const probeMessage = probeCall[1]!;
      expect(probeMessage).toBe('Database connectivity probe failed');
      expect(probePayload).toMatchObject({
        err: probeError,
        host: 'db.example.com',
        port: '5432',
      });
      expect(probePayload['hint']).toContain('Postgres host refused connection');
    });

    it('should log structured migration failure with err/hint and rethrow with cause when migrate() fails', async () => {
      const migrateError = Object.assign(new Error('Failed query: CREATE SCHEMA "drizzle"'), {
        code: '42501',
      });
      mockMigrate.mockRejectedValueOnce(migrateError);

      try {
        await service.onModuleInit();
        expect.fail('expected onModuleInit to throw');
      } catch (error) {
        expect((error as Error).message).toBe('Migration failed');
        expect((error as Error).cause).toBe(migrateError);
      }

      expect(logger.error).toHaveBeenCalledTimes(1);
      const migrationCall = vi.mocked(logger.error).mock.calls[0]!;
      const migrationPayload = migrationCall[0] as Record<string, unknown>;
      const migrationMessage = migrationCall[1]!;
      expect(migrationMessage).toBe('Database migration failed');
      expect(migrationPayload).toMatchObject({ err: migrateError });
      expect(migrationPayload['hint']).toContain('Insufficient privilege');
    });

    it('should still log a probe failure (with undefined host/port) when DATABASE_URL is malformed', async () => {
      mockConfigService.get.mockReturnValueOnce('not-a-valid-url');
      // Re-create the service with the malformed URL.
      await module.close();
      module = await Test.createTestingModule({
        providers: [
          DatabaseService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: getLoggerToken(DatabaseService.name), useValue: logger },
        ],
      }).compile();
      service = module.get<DatabaseService>(DatabaseService);

      const probeError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      mockExecute.mockRejectedValueOnce(probeError);

      await expect(service.onModuleInit()).rejects.toThrow('Database connectivity probe failed');

      const malformedCall = vi.mocked(logger.error).mock.calls[0]!;
      const malformedPayload = malformedCall[0] as Record<string, unknown>;
      expect(malformedPayload).toMatchObject({ err: probeError, host: undefined, port: undefined });
    });
  });

  describe('onModuleDestroy', () => {
    it('should close the underlying postgres client and log shutdown', async () => {
      await service.onModuleDestroy();

      expect(mockEnd).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Database connection closed');
    });
  });
});
