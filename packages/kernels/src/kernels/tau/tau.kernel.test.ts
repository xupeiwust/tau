import { describe, it, expect, vi, afterEach } from 'vitest';
import { importToGlb, exportFromGlb } from '@taucad/converter';
import type { KernelFileSystem } from '#types/kernel-worker.types.js';
import tauKernel from '#kernels/tau/tau.kernel.js';

vi.mock('@taucad/converter', () => ({
  importToGlb: vi.fn(),
  exportFromGlb: vi.fn(),
  supportedImportFormats: ['step', 'stl', 'obj', 'iges', 'brep', 'gltf', 'glb', '3mf', 'fbx', 'dxf'],
}));

function createMockFilesystem(overrides?: Partial<KernelFileSystem>): KernelFileSystem {
  return {
    readFile: vi.fn().mockResolvedValue(new Uint8Array([0x53, 0x54, 0x45, 0x50])),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 100, mtimeMs: Date.now() }),
    exists: vi.fn().mockResolvedValue(false),
    touch: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    ...overrides,
  } as unknown as KernelFileSystem;
}

function createMockLogger() {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    custom: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The kernel definition methods use complex generics (KernelDefinition<Context, NativeHandle, Options>).
// Calling methods directly requires `as never` casts for the generic input/runtime/context params,
// and `expect.any()` returns `any` which triggers no-unsafe-assignment.
// oxlint-disable consistent-type-assertions, no-unsafe-assignment -- kernel test helpers need casts for generic params

describe('TauKernel', () => {
  describe('canHandle', () => {
    it('should return true for STEP extension', async () => {
      const result = await tauKernel.canHandle({ extension: 'step' } as never, {} as never, undefined as never);
      expect(result).toBe(true);
    });

    it('should return false for unsupported extension', async () => {
      const result = await tauKernel.canHandle({ extension: 'xyz' } as never, {} as never, undefined as never);
      expect(result).toBe(false);
    });
  });

  describe('getDependencies', () => {
    it('should return array containing the input filePath', async () => {
      const result = await tauKernel.getDependencies(
        { filePath: '/models/part.step' } as never,
        {} as never,
        undefined as never,
      );
      expect(result).toEqual(['/models/part.step']);
    });
  });

  describe('getParameters', () => {
    it('should return empty default parameters and empty JSON schema', async () => {
      const result = await tauKernel.getParameters({} as never, {} as never, undefined as never);
      expect(result).toEqual({
        success: true,
        data: {
          defaultParameters: {},
          jsonSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        issues: [],
      });
    });
  });

  describe('initialize', () => {
    it('should resolve with empty config', async () => {
      const result = await tauKernel.initialize({} as never, {} as never, undefined as never);
      expect(result).toEqual({});
    });
  });

  describe('createGeometry', () => {
    it('should call importToGlb with file content and return geometry with gltf format', async () => {
      const glbData = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
      vi.mocked(importToGlb).mockResolvedValue(glbData);

      const filesystem = createMockFilesystem();
      const logger = createMockLogger();

      const result = await tauKernel.createGeometry(
        { filePath: '/models/part.step', basePath: '/models' } as never,
        { filesystem, logger } as never,
        undefined as never,
      );

      expect(importToGlb).toHaveBeenCalledWith(
        [{ name: 'part.step', bytes: expect.any(Uint8Array) }],
        'step',
        expect.objectContaining({ exists: expect.any(Function), readFile: expect.any(Function) }),
      );
      expect(result).toEqual({
        geometry: [{ format: 'gltf', content: glbData }],
        nativeHandle: glbData,
      });
    });

    it('should throw with structured issues when importToGlb fails', async () => {
      vi.mocked(importToGlb).mockRejectedValue(new Error('conversion failed'));

      const filesystem = createMockFilesystem();
      const logger = createMockLogger();

      try {
        await tauKernel.createGeometry(
          { filePath: '/models/part.step', basePath: '/models' } as never,
          { filesystem, logger } as never,
          undefined as never,
        );
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('conversion failed');
        expect((error as { issues: Array<{ message: string }> }).issues).toBeDefined();
        expect((error as { issues: Array<{ message: string }> }).issues[0]!.message).toBe('conversion failed');
      }
    });
  });

  describe('exportGeometry', () => {
    it('should call exportFromGlb with native handle and file type', async () => {
      const exportedFiles = [{ name: 'model.stl', bytes: new Uint8Array([1, 2, 3]) }];
      vi.mocked(exportFromGlb).mockResolvedValue(exportedFiles);

      const logger = createMockLogger();
      const nativeHandle = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

      const result = await tauKernel.exportGeometry(
        { fileType: 'stl', nativeHandle } as never,
        { logger } as never,
        undefined as never,
      );

      expect(exportFromGlb).toHaveBeenCalledWith(nativeHandle, 'stl');
      expect(result).toEqual({
        success: true,
        data: exportedFiles,
        issues: [],
      });
    });

    it('should return error result when nativeHandle is empty', async () => {
      const logger = createMockLogger();

      const result = await tauKernel.exportGeometry(
        { fileType: 'stl', nativeHandle: new Uint8Array(0) } as never,
        { logger } as never,
        undefined as never,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]!.message).toContain('No geometry available');
      }
    });

    it('should return error result when exportFromGlb throws', async () => {
      vi.mocked(exportFromGlb).mockRejectedValue(new Error('export failed'));

      const logger = createMockLogger();
      const nativeHandle = new Uint8Array([1, 2, 3]);

      const result = await tauKernel.exportGeometry(
        { fileType: 'stl', nativeHandle } as never,
        { logger } as never,
        undefined as never,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]!.message).toBe('export failed');
      }
    });
  });
});
