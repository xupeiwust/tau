/**
 * Tests for the parameter cache middleware.
 * Tests the wrap-style hook with onion model execution.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ExtractParametersResult,
  ExtractParametersRequest,
  ExtractParametersHandler,
  Dependency,
} from '@taucad/types';
import { parameterCacheMiddleware } from '#components/geometry/kernel/utils/parameter-cache.middleware.js';
import { createMockRuntime, createMockInput } from '#components/geometry/kernel/utils/kernel-testing.utils.js';

/**
 * Create mock dependencies for testing.
 */
function createMockDependencies(overrides?: Array<Partial<Dependency>>): readonly Dependency[] {
  const defaults: Dependency[] = [
    { type: 'file', path: 'test.kcl', contentHash: 'abc123' },
    { type: 'middleware', name: 'TestMiddleware', version: '1', index: 0 },
    { type: 'framework', name: 'tau', version: '0.0.1' },
  ];

  if (overrides) {
    return [...defaults, ...(overrides as Dependency[])];
  }

  return defaults;
}

/** The data type for a successful ExtractParametersResult */
type ExtractParametersData = {
  defaultParameters: Record<string, unknown>;
  jsonSchema: unknown;
};

/**
 * Create a successful extract parameters result for testing.
 */
function createSuccessResult(overrides?: Partial<ExtractParametersData>): ExtractParametersResult {
  return {
    success: true,
    data: {
      defaultParameters: { width: 10, height: 20 },
      jsonSchema: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      ...overrides,
    },
    issues: [],
  };
}

/**
 * Create an error result for testing.
 */
function createErrorResult(): ExtractParametersResult {
  return {
    success: false,
    issues: [{ severity: 'error', message: 'Test error' }],
  };
}

/**
 * Create serialized cache content (JSON format).
 */
function createSerializedCacheContent(result: ExtractParametersResult): string {
  return JSON.stringify(result);
}

/**
 * Create a request with runtime configured for cache testing.
 */
function createCacheRequest(options?: {
  cacheExists?: boolean;
  cachedResult?: ExtractParametersResult;
  input?: Parameters<typeof createMockInput>[0];
  dependencies?: readonly Dependency[];
  dependencyHash?: string;
}): ExtractParametersRequest & {
  runtime: ReturnType<typeof createMockRuntime>;
} {
  const serializedContent = options?.cachedResult ? createSerializedCacheContent(options.cachedResult) : '';

  const runtime = createMockRuntime({
    fileManagerOptions: {
      existsResult: options?.cacheExists ?? false,
      readFileResult: serializedContent,
    },
    dependencies: options?.dependencies ?? createMockDependencies(),
    dependencyHash: options?.dependencyHash ?? 'a'.repeat(64),
  });

  return {
    input: createMockInput(options?.input),
    runtime,
  };
}

/**
 * Create a mock handler for testing.
 */
function createMockHandler(result?: ExtractParametersResult): ExtractParametersHandler {
  return vi.fn().mockResolvedValue(result ?? createSuccessResult());
}

describe('parameterCacheMiddleware', () => {
  describe('wrapExtractParameters', () => {
    describe('cache hit', () => {
      it('should return cached result and not call handler', async () => {
        const cachedResult = createSuccessResult({ defaultParameters: { cached: true } });

        const request = createCacheRequest({
          cacheExists: true,
          cachedResult,
        });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        expect(wrapExtractParameters).toBeDefined();

        const result = await wrapExtractParameters!(request, handler);

        // Handler should not be called on cache hit
        expect(handler).not.toHaveBeenCalled();

        // Result should be from cache
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.defaultParameters).toEqual({ cached: true });
        }
      });

      it('should log cache hit message', async () => {
        const cachedResult = createSuccessResult();
        const request = createCacheRequest({
          cacheExists: true,
          cachedResult,
        });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('cache hit'));
      });

      it('should preserve jsonSchema from cached result', async () => {
        const cachedResult = createSuccessResult({
          jsonSchema: {
            type: 'object',
            properties: {
              customProp: { type: 'string', default: 'test' },
            },
          },
        });

        const request = createCacheRequest({
          cacheExists: true,
          cachedResult,
        });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        const result = await wrapExtractParameters!(request, handler);

        expect(result.success).toBe(true);
        if (result.success) {
          const schema = result.data.jsonSchema as { properties?: Record<string, unknown> };
          expect(schema.properties).toHaveProperty('customProp');
        }
      });
    });

    describe('cache miss', () => {
      it('should call handler and return its result', async () => {
        const handlerResult = createSuccessResult({ defaultParameters: { fresh: true } });
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        const result = await wrapExtractParameters!(request, handler);

        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should log cache miss message', async () => {
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('cache miss'));
      });

      it('should write result to cache after handler returns', async () => {
        const handlerResult = createSuccessResult();
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.fileManager.writeFile).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const writePath = request.runtime.fileManager.writeFile.mock.calls[0]?.[0];
        expect(writePath).toContain('.tau/cache/parameters');
        expect(writePath).toContain('.json');
      });

      it('should write valid JSON to cache', async () => {
        const handlerResult = createSuccessResult({ defaultParameters: { a: 1, b: 2 } });
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const writeContent = request.runtime.fileManager.writeFile.mock.calls[0]?.[1];
        expect(writeContent).toBeDefined();
        expect(typeof writeContent).toBe('string');

        // Should be valid JSON
        const parsed = JSON.parse(writeContent as string) as ExtractParametersResult;
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.defaultParameters).toEqual({ a: 1, b: 2 });
        }
      });

      it('should ensure cache directory exists before writing', async () => {
        const handlerResult = createSuccessResult();
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.fileManager.ensureDirectoryExists).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const dirPath = request.runtime.fileManager.ensureDirectoryExists.mock.calls[0]?.[0];
        expect(dirPath).toContain('.tau/cache/parameters');
      });

      it('should log cache write message', async () => {
        const handlerResult = createSuccessResult();
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cached parameters'));
      });

      it('should not cache failed results', async () => {
        const errorResult = createErrorResult();
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(errorResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.fileManager.writeFile).not.toHaveBeenCalled();
      });
    });

    describe('dependency hash usage', () => {
      it('should use runtime.dependencyHash for cache path', async () => {
        const dependencyHash = 'b'.repeat(64);
        const request = createCacheRequest({
          cacheExists: false,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        // Verify that writeFile was called with a path containing the dependency hash
        expect(request.runtime.fileManager.writeFile).toHaveBeenCalledWith(
          expect.stringContaining(dependencyHash),
          expect.any(String),
        );
      });

      it('should use runtime.dependencyHash for cache lookup', async () => {
        const dependencyHash = 'c'.repeat(64);
        const cachedResult = createSuccessResult();
        const request = createCacheRequest({
          cacheExists: true,
          cachedResult,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        // Verify that exists was called with a path containing the dependency hash
        expect(request.runtime.fileManager.exists).toHaveBeenCalledWith(expect.stringContaining(dependencyHash));
      });

      it('should result in cache miss when dependencyHash differs', async () => {
        const dependencyHash = 'different'.repeat(8);
        const request = createCacheRequest({
          cacheExists: false,
          dependencyHash,
        });

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        // Handler should be called because cache missed
        expect(handler).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle file read errors gracefully', async () => {
        const request = createCacheRequest({ cacheExists: true });
        // Make readFile throw an error
        request.runtime.fileManager.readFile.mockRejectedValue(new Error('Read error'));

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        const result = await wrapExtractParameters!(request, handler);

        // Should treat as cache miss and call handler
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should log cache read error', async () => {
        const request = createCacheRequest({ cacheExists: true });
        request.runtime.fileManager.readFile.mockRejectedValue(new Error('Read error'));

        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('cache read error'));
      });

      it('should handle file write errors gracefully', async () => {
        const request = createCacheRequest({ cacheExists: false });
        // Make writeFile throw an error
        request.runtime.fileManager.writeFile.mockRejectedValue(new Error('Write error'));

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        // Should not throw, just log warning
        const result = await wrapExtractParameters!(request, handler);

        expect(result).toBe(handlerResult);
        expect(request.runtime.logger.warn).toHaveBeenCalledWith(expect.stringContaining('cache write error'));
      });

      it('should handle JSON parse errors gracefully', async () => {
        const request = createCacheRequest({ cacheExists: true });
        // Return invalid JSON
        request.runtime.fileManager.readFile.mockResolvedValue('not valid json {{{');

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapExtractParameters } = parameterCacheMiddleware;
        const result = await wrapExtractParameters!(request, handler);

        // Should treat as cache miss and call handler
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });
    });

    describe('cache path structure', () => {
      it('should use correct cache path format', async () => {
        const dependencyHash = 'd'.repeat(64);
        const request = createCacheRequest({
          cacheExists: false,
          dependencyHash,
          input: { basePath: '/test/project' },
        });
        const handler = createMockHandler();

        const { wrapExtractParameters } = parameterCacheMiddleware;
        await wrapExtractParameters!(request, handler);

        expect(request.runtime.fileManager.exists).toHaveBeenCalledWith(
          `/test/project/.tau/cache/parameters/${dependencyHash}.json`,
        );
      });
    });
  });
});
