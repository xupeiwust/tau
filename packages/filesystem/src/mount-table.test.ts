import { describe, it, expect, beforeEach } from 'vitest';
import { MountTable } from '#mount-table.js';
import { createMemoryProvider } from '#providers/memory-provider.js';
import type { FileSystemProvider } from '#types.js';

describe('MountTable', () => {
  let rootProvider: FileSystemProvider;
  let nodeModulesProvider: FileSystemProvider;
  let mountTable: MountTable;

  beforeEach(async () => {
    rootProvider = await createMemoryProvider();
    nodeModulesProvider = await createMemoryProvider();
    mountTable = new MountTable();
  });

  describe('mount / unmount', () => {
    it('should mount and resolve a root provider', () => {
      mountTable.mount('/', rootProvider);
      const result = mountTable.resolve('/some/file.ts');
      expect(result.provider).toBe(rootProvider);
      expect(result.path).toBe('/some/file.ts');
    });

    it('should unmount a provider', () => {
      mountTable.mount('/', rootProvider);
      mountTable.unmount('/');
      expect(() => mountTable.resolve('/file.ts')).toThrow();
    });

    it('should throw when no mount matches', () => {
      expect(() => mountTable.resolve('/file.ts')).toThrow();
    });
  });

  describe('longest-prefix matching', () => {
    it('should route /node_modules/ paths to mounted provider', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);

      const result = mountTable.resolve('/node_modules/lodash/index.js');
      expect(result.provider).toBe(nodeModulesProvider);
      expect(result.path).toBe('/lodash/index.js');
    });

    it('should route non-/node_modules/ paths to root provider', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);

      const result = mountTable.resolve('/src/main.ts');
      expect(result.provider).toBe(rootProvider);
      expect(result.path).toBe('/src/main.ts');
    });

    it('should resolve exact mount prefix path', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);

      const result = mountTable.resolve('/node_modules');
      expect(result.provider).toBe(nodeModulesProvider);
      expect(result.path).toBe('/');
    });

    it('should prefer longer prefix over shorter', async () => {
      const scopeProvider = await createMemoryProvider();
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);
      mountTable.mount('/node_modules/@scope', scopeProvider);

      const result = mountTable.resolve('/node_modules/@scope/pkg/index.js');
      expect(result.provider).toBe(scopeProvider);
      expect(result.path).toBe('/pkg/index.js');
    });
  });

  describe('getMountsUnder', () => {
    it('should return child mounts', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);

      const children = mountTable.getMountsUnder('/');
      expect(children).toHaveLength(1);
      expect(children[0]!.prefix).toBe('/node_modules');
    });

    it('should return empty for leaf mounts', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);

      const children = mountTable.getMountsUnder('/node_modules');
      expect(children).toHaveLength(0);
    });

    it('should not include the mount itself', () => {
      mountTable.mount('/', rootProvider);
      const children = mountTable.getMountsUnder('/');
      expect(children).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle trailing slashes on resolve', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);

      const result = mountTable.resolve('/node_modules/');
      expect(result.provider).toBe(nodeModulesProvider);
      expect(result.path).toBe('/');
    });

    it('should handle root path resolution', () => {
      mountTable.mount('/', rootProvider);
      const result = mountTable.resolve('/');
      expect(result.provider).toBe(rootProvider);
      expect(result.path).toBe('/');
    });

    it('should maintain sorted order after multiple mount/unmount', async () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/a/b/c', nodeModulesProvider);
      mountTable.mount('/a', await createMemoryProvider());
      mountTable.unmount('/a');
      mountTable.mount('/a/b', await createMemoryProvider());

      const result = mountTable.resolve('/a/b/c/file.ts');
      expect(result.provider).toBe(nodeModulesProvider);
      expect(result.path).toBe('/file.ts');
    });
  });

  describe('dispose', () => {
    it('should clear all mounts', () => {
      mountTable.mount('/', rootProvider);
      mountTable.mount('/node_modules', nodeModulesProvider);
      mountTable.dispose();
      expect(() => mountTable.resolve('/file.ts')).toThrow();
    });
  });
});
