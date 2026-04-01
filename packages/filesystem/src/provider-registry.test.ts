import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ProviderRegistry } from '#provider-registry.js';
import type { FileSystemProvider } from '#types.js';

const createMockHandle = (name: string): FileSystemDirectoryHandle => mock<FileSystemDirectoryHandle>({ name });

vi.mock('#providers/direct-idb-provider.js', () => {
  class MockDirectIdbProvider {
    public id = 'indexeddb';
    public capabilities = { persistent: true, writable: true, quotaBased: true };
    public readFile = vi.fn() as FileSystemProvider['readFile'];
    public writeFile = vi.fn();
    public readdir = vi.fn();
    public stat = vi.fn();
    public mkdir = vi.fn();
    public unlink = vi.fn();
    public rmdir = vi.fn();
    public rename = vi.fn();
    public exists = vi.fn();
    public lstat = vi.fn();
    public dispose = vi.fn();
    public initialize = vi.fn();
  }
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Module export must match class name
  return { DirectIdbProvider: MockDirectIdbProvider };
});

vi.mock('#providers/memory-provider.js', () => {
  class MockMemoryProvider {
    public id = 'memory';
    public capabilities = { persistent: false, writable: true, quotaBased: false };
    public readFile = vi.fn() as FileSystemProvider['readFile'];
    public writeFile = vi.fn();
    public readdir = vi.fn();
    public stat = vi.fn();
    public mkdir = vi.fn();
    public unlink = vi.fn();
    public rmdir = vi.fn();
    public rename = vi.fn();
    public exists = vi.fn();
    public lstat = vi.fn();
    public dispose = vi.fn();
  }
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Module export must match class name
  return { MemoryProvider: MockMemoryProvider };
});

vi.mock('#providers/fs-access-provider.js', () => {
  class MockFileSystemAccessProvider {
    public id = 'webaccess';
    public capabilities = { persistent: true, writable: true, quotaBased: false };
    public readFile = vi.fn() as FileSystemProvider['readFile'];
    public writeFile = vi.fn();
    public readdir = vi.fn();
    public stat = vi.fn();
    public mkdir = vi.fn();
    public unlink = vi.fn();
    public rmdir = vi.fn();
    public rename = vi.fn();
    public exists = vi.fn();
    public lstat = vi.fn();
    public dispose = vi.fn();
  }
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Module export must match class name
  return { FileSystemAccessProvider: MockFileSystemAccessProvider };
});

vi.mock('#providers/opfs-provider.js', () => {
  class MockOPFSProvider {
    public id = 'opfs';
    public capabilities = { persistent: true, writable: true, quotaBased: true };
    public readFile = vi.fn() as FileSystemProvider['readFile'];
    public writeFile = vi.fn();
    public readdir = vi.fn();
    public stat = vi.fn();
    public mkdir = vi.fn();
    public unlink = vi.fn();
    public rmdir = vi.fn();
    public rename = vi.fn();
    public exists = vi.fn();
    public lstat = vi.fn();
    public dispose = vi.fn();
    public initialize = vi.fn();
  }
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Module export must match class name
  return { OPFSProvider: MockOPFSProvider };
});

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ProviderRegistry();
  });

  describe('constructor', () => {
    it('should default activeBackend to indexeddb', () => {
      expect(registry.activeBackend).toBe('indexeddb');
    });

    it('should accept custom databasePrefix', async () => {
      const custom = new ProviderRegistry({ databasePrefix: 'custom' });
      expect(custom.activeBackend).toBe('indexeddb');
    });
  });

  describe('getActiveProvider', () => {
    it('should return a provider for the default backend', async () => {
      const provider = await registry.getActiveProvider();
      expect(provider.id).toBe('indexeddb');
    });

    it('should return the same cached instance on repeated calls', async () => {
      const first = await registry.getActiveProvider();
      const second = await registry.getActiveProvider();
      expect(first).toBe(second);
    });
  });

  describe('switchActiveProvider', () => {
    it('should change the active backend', async () => {
      await registry.switchActiveProvider('memory');
      expect(registry.activeBackend).toBe('memory');
    });

    it('should return new provider type after switch', async () => {
      await registry.switchActiveProvider('memory');
      const provider = await registry.getActiveProvider();
      expect(provider.id).toBe('memory');
    });

    it('should dispose the previous provider when switching to same backend', async () => {
      const first = await registry.getProvider('memory');
      await registry.switchActiveProvider('memory');
      expect(first.dispose).toHaveBeenCalled();
    });

    it('should dispose and recreate when switching to same backend twice', async () => {
      await registry.switchActiveProvider('memory');
      const first = await registry.getActiveProvider();
      await registry.switchActiveProvider('memory');
      const second = await registry.getActiveProvider();
      expect(first.dispose).toHaveBeenCalled();
      expect(first).not.toBe(second);
    });
  });

  describe('getProvider', () => {
    it('should return provider for a specific backend', async () => {
      const provider = await registry.getProvider('memory');
      expect(provider.id).toBe('memory');
    });

    it('should cache providers per backend', async () => {
      const first = await registry.getProvider('memory');
      const second = await registry.getProvider('memory');
      expect(first).toBe(second);
    });

    it('should default to active backend when no argument provided', async () => {
      const provider = await registry.getProvider();
      expect(provider.id).toBe('indexeddb');
    });

    it('should throw for unknown backend', async () => {
      // oxlint-disable-next-line no-explicit-any,no-unsafe-argument -- intentionally testing invalid input
      await expect(registry.getProvider('nonexistent' as any)).rejects.toThrow('Unknown backend: nonexistent');
    });
  });

  describe('getStandaloneProvider', () => {
    it('should return a standalone provider cached separately', async () => {
      const active = await registry.getProvider('memory');
      const standalone = await registry.getStandaloneProvider('memory');
      expect(active).not.toBe(standalone);
    });

    it('should cache standalone providers', async () => {
      const first = await registry.getStandaloneProvider('memory');
      const second = await registry.getStandaloneProvider('memory');
      expect(first).toBe(second);
    });
  });

  describe('invalidateStandaloneProvider', () => {
    it('should dispose and remove standalone provider for a backend', async () => {
      const standalone = await registry.getStandaloneProvider('memory');
      registry.invalidateStandaloneProvider('memory');
      expect(standalone.dispose).toHaveBeenCalled();

      const renewed = await registry.getStandaloneProvider('memory');
      expect(renewed).not.toBe(standalone);
    });

    it('should not affect subsequent provider creation when no standalone exists', async () => {
      registry.invalidateStandaloneProvider('memory');
      const provider = await registry.getStandaloneProvider('memory');
      expect(provider).toBeDefined();
      expect(provider.id).toBe('memory');
    });
  });

  describe('disposeAll', () => {
    it('should dispose all active providers', async () => {
      const indexeddb = await registry.getProvider('indexeddb');
      const memory = await registry.getProvider('memory');
      registry.disposeAll();
      expect(indexeddb.dispose).toHaveBeenCalled();
      expect(memory.dispose).toHaveBeenCalled();
    });

    it('should dispose all standalone providers', async () => {
      const standalone = await registry.getStandaloneProvider('memory');
      registry.disposeAll();
      expect(standalone.dispose).toHaveBeenCalled();
    });

    it('should allow new provider creation after disposing empty registry', async () => {
      registry.disposeAll();
      const provider = await registry.getProvider('memory');
      expect(provider).toBeDefined();
      expect(provider.id).toBe('memory');
    });

    it('should create fresh providers after disposeAll', async () => {
      const before = await registry.getProvider('memory');
      registry.disposeAll();
      const after = await registry.getProvider('memory');
      expect(before).not.toBe(after);
    });
  });

  describe('activeBackend', () => {
    it('should reflect the current active backend', async () => {
      expect(registry.activeBackend).toBe('indexeddb');
      await registry.switchActiveProvider('memory');
      expect(registry.activeBackend).toBe('memory');
    });
  });

  describe('webaccess backend', () => {
    it('should throw when no directory handle is set', async () => {
      await expect(registry.getProvider('webaccess')).rejects.toThrow('No directory handle set');
    });

    it('should return provider after setDirectoryHandle', async () => {
      const mockHandle = createMockHandle('test-dir');
      registry.setDirectoryHandle(mockHandle);
      const provider = await registry.getProvider('webaccess');
      expect(provider.id).toBe('webaccess');
    });

    it('should invalidate webaccess standalone providers when setDirectoryHandle is called', async () => {
      const mockHandle = createMockHandle('test-dir');
      registry.setDirectoryHandle(mockHandle);
      const standalone = await registry.getStandaloneProvider('webaccess', mockHandle);
      const newHandle = createMockHandle('new-dir');
      registry.setDirectoryHandle(newHandle);
      expect(standalone.dispose).toHaveBeenCalled();
    });
  });

  describe('switchActiveProvider with handle', () => {
    it('should store handle when switching to webaccess', async () => {
      const mockHandle = createMockHandle('test-dir');
      await registry.switchActiveProvider('webaccess', mockHandle);
      const provider = await registry.getActiveProvider();
      expect(provider.id).toBe('webaccess');
    });
  });

  describe('native provider instantiation', () => {
    it('should create DirectIdbProvider for indexeddb backend', async () => {
      const provider = await registry.getProvider('indexeddb');
      expect(provider.id).toBe('indexeddb');
      expect(provider.capabilities).toEqual({ persistent: true, writable: true, quotaBased: true });
    });

    it('should create OPFSProvider for opfs backend', async () => {
      const provider = await registry.getProvider('opfs');
      expect(provider.id).toBe('opfs');
      expect(provider.capabilities).toEqual({ persistent: true, writable: true, quotaBased: true });
    });

    it('should create FileSystemAccessProvider for webaccess backend with handle', async () => {
      const mockHandle = createMockHandle('local-dir');
      registry.setDirectoryHandle(mockHandle);
      const provider = await registry.getProvider('webaccess');
      expect(provider.id).toBe('webaccess');
      expect(provider.capabilities).toEqual({ persistent: true, writable: true, quotaBased: false });
    });
  });
});
