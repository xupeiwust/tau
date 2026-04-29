// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { createFileSystemService } from '#file-system-service.js';
import { createMemoryProvider } from '#backend/memory-provider.js';
import type { ChangeEvent, WatchEvent } from '#types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('createFileSystemService', () => {
  describe('mount/unmount', () => {
    it('should accept a single root mount and route reads through it', async () => {
      const provider = await createMemoryProvider();
      await provider.writeFile('/foo.txt', 'hello');

      const service = createFileSystemService();
      service.mount('/', provider);

      expect(dec.decode(await service.readFile('/foo.txt'))).toBe('hello');

      service.dispose();
    });

    it('should return a Disposable from mount() that unmounts on dispose()', async () => {
      const provider = await createMemoryProvider();
      await provider.writeFile('/foo.txt', 'hello');

      const service = createFileSystemService();
      const disposable = service.mount('/', provider);
      disposable.dispose();

      await expect(service.readFile('/foo.txt')).rejects.toThrow();

      service.dispose();
    });

    it('should unmount via prefix', async () => {
      const provider = await createMemoryProvider();
      const service = createFileSystemService();
      service.mount('/', provider);
      service.unmount('/');

      await expect(service.readFile('/foo.txt')).rejects.toThrow();

      service.dispose();
    });
  });

  describe('longest-prefix routing', () => {
    it('should route paths to the most-specific mount', async () => {
      const root = await createMemoryProvider();
      const overlay = await createMemoryProvider();
      await root.writeFile('/a.txt', 'root');
      await overlay.writeFile('/b.txt', 'overlay');

      const service = createFileSystemService();
      service.mount('/', root);
      service.mount('/sub', overlay);

      expect(dec.decode(await service.readFile('/a.txt'))).toBe('root');
      expect(dec.decode(await service.readFile('/sub/b.txt'))).toBe('overlay');

      service.dispose();
    });
  });

  describe('writeFile / unlink / stat', () => {
    it('should round-trip writes and stats through the mounted provider', async () => {
      const provider = await createMemoryProvider();
      const service = createFileSystemService();
      service.mount('/', provider);

      await service.writeFile('/x.txt', enc.encode('xyz'));
      const stat = await service.stat('/x.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(3);

      await service.unlink('/x.txt');
      expect(await service.exists('/x.txt')).toBe(false);

      service.dispose();
    });
  });

  describe('watch fan-out', () => {
    it('should deliver events from any mounted provider via the change event bus', async () => {
      const provider = await createMemoryProvider();
      const service = createFileSystemService();
      service.mount('/', provider);

      const events: WatchEvent[] = [];
      const subscription = service.watch({ paths: ['/foo.txt'] }, (event) => {
        events.push(event);
      });

      const change: ChangeEvent = {
        type: 'fileWritten',
        path: '/foo.txt',
        backend: 'memory',
      };
      service.publishChangeEvent(change);

      // Wait past the WatchRegistry coalescing window.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(events.length).toBeGreaterThan(0);

      subscription.dispose();
      service.dispose();
    });
  });

  describe('cache plumbing', () => {
    it('should consult the FileContentCache before delegating to the provider', async () => {
      const provider = await createMemoryProvider();
      await provider.writeFile('/a.txt', 'disk-bytes');
      const readSpy = vi.spyOn(provider, 'readFile');

      const cached = new Map<string, Uint8Array<ArrayBuffer>>();
      cached.set('/a.txt', enc.encode('cached-bytes'));

      const service = createFileSystemService({
        cache: {
          get: (path) => cached.get(path),
          put: (path, bytes) => {
            cached.set(path, bytes);
          },
          invalidate: (path) => {
            cached.delete(path);
          },
          invalidateAll: () => {
            cached.clear();
          },
          on: () => ({ dispose: () => undefined }),
        },
      });
      service.mount('/', provider);

      const bytes = await service.readFile('/a.txt');
      expect(dec.decode(bytes)).toBe('cached-bytes');
      expect(readSpy).not.toHaveBeenCalled();

      service.dispose();
    });

    it('should invalidate the cache on writeFile', async () => {
      const provider = await createMemoryProvider();
      const cached = new Map<string, Uint8Array<ArrayBuffer>>();
      cached.set('/a.txt', enc.encode('stale'));

      const service = createFileSystemService({
        cache: {
          get: (path) => cached.get(path),
          put: (path, bytes) => {
            cached.set(path, bytes);
          },
          invalidate: (path) => {
            cached.delete(path);
          },
          invalidateAll: () => {
            cached.clear();
          },
          on: () => ({ dispose: () => undefined }),
        },
      });
      service.mount('/', provider);

      await service.writeFile('/a.txt', enc.encode('fresh'));
      expect(cached.has('/a.txt')).toBe(false);

      service.dispose();
    });
  });

  describe('asProvider()', () => {
    it('should return a FileSystemProvider that round-trips through the service', async () => {
      const provider = await createMemoryProvider();
      const service = createFileSystemService();
      service.mount('/', provider);

      const facade = service.asProvider();
      await facade.writeFile('/y.txt', enc.encode('hi'));
      const bytes = await facade.readFile('/y.txt');
      expect(dec.decode(bytes)).toBe('hi');

      service.dispose();
    });

    it('should expose stable id and writable capabilities', () => {
      const service = createFileSystemService();
      const facade = service.asProvider();
      expect(typeof facade.id).toBe('string');
      expect(facade.capabilities.writable).toBe(true);

      service.dispose();
    });
  });

  describe('asRuntimeFileSystem()', () => {
    it('should return a RuntimeFileSystem that round-trips through the service', async () => {
      const provider = await createMemoryProvider();
      const service = createFileSystemService();
      service.mount('/', provider);

      const runtime = service.asRuntimeFileSystem();
      await runtime.writeFile('/z.txt', enc.encode('rt'));
      expect(dec.decode(await runtime.readFile('/z.txt'))).toBe('rt');

      service.dispose();
    });

    it('should expose readFiles helper that batches reads', async () => {
      const provider = await createMemoryProvider();
      await provider.writeFile('/a.txt', 'a');
      await provider.writeFile('/b.txt', 'b');

      const service = createFileSystemService();
      service.mount('/', provider);

      const runtime = service.asRuntimeFileSystem();
      const map = await runtime.readFiles(['/a.txt', '/b.txt']);
      expect(dec.decode(map['/a.txt'])).toBe('a');
      expect(dec.decode(map['/b.txt'])).toBe('b');

      service.dispose();
    });

    it('should expose ensureDir helper that creates parent directories', async () => {
      const provider = await createMemoryProvider();
      const service = createFileSystemService();
      service.mount('/', provider);

      const runtime = service.asRuntimeFileSystem();
      await runtime.ensureDir('/nested/dir');
      const directoryStat = await runtime.stat('/nested/dir');
      expect(directoryStat.type).toBe('dir');

      service.dispose();
    });
  });
});
