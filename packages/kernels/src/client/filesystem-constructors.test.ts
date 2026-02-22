import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configure, fs } from '@zenfs/core';
import { InMemory } from '@zenfs/core/backends/memory.js';
import { fromZenFS, fromMemoryFS } from '#client/filesystem-constructors.js';
import { fromProxy } from '#filesystem/from-proxy.js';

describe('filesystem constructors', () => {
  describe('fromZenFS', () => {
    beforeEach(async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem mount point requires '/' as key
      await configure({ mounts: { '/': InMemory } });
    });

    it('should read a file as utf8', async () => {
      await fs.promises.writeFile('/test.txt', 'hello world');
      const fileSystem = fromZenFS(fs);

      const content = await fileSystem.readFile('/test.txt', 'utf8');
      expect(content).toBe('hello world');
    });

    it('should read a file as Uint8Array', async () => {
      await fs.promises.writeFile('/bin.txt', 'binary');
      const fileSystem = fromZenFS(fs);

      const content = await fileSystem.readFile('/bin.txt');
      expect(content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(content)).toBe('binary');
    });

    it('should write and read back a file', async () => {
      const fileSystem = fromZenFS(fs);

      await fileSystem.writeFile('/new.txt', 'written');
      const content = await fileSystem.readFile('/new.txt', 'utf8');
      expect(content).toBe('written');
    });

    it('should create directories', async () => {
      const fileSystem = fromZenFS(fs);

      await fileSystem.mkdir('/mydir');
      const stat = await fileSystem.stat('/mydir');
      expect(stat.type).toBe('dir');
    });

    it('should create directories recursively', async () => {
      const fileSystem = fromZenFS(fs);

      await fileSystem.mkdir('/a/b/c', { recursive: true });
      const stat = await fileSystem.stat('/a/b/c');
      expect(stat.type).toBe('dir');
    });

    it('should list directory contents', async () => {
      await fs.promises.writeFile('/dir-test.txt', 'data');
      const fileSystem = fromZenFS(fs);

      const entries = await fileSystem.readdir('/');
      expect(entries).toContain('dir-test.txt');
    });

    it('should delete a file', async () => {
      await fs.promises.writeFile('/del.txt', 'gone');
      const fileSystem = fromZenFS(fs);

      await fileSystem.unlink('/del.txt');
      const exists = await fileSystem.exists('/del.txt');
      expect(exists).toBe(false);
    });

    it('should stat a file with correct metadata', async () => {
      await fs.promises.writeFile('/stat.txt', 'abcde');
      const fileSystem = fromZenFS(fs);

      const stat = await fileSystem.stat('/stat.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(5);
      expect(stat.mtimeMs).toBeTypeOf('number');
    });

    it('should stat a directory', async () => {
      await fs.promises.mkdir('/statdir');
      const fileSystem = fromZenFS(fs);

      const stat = await fileSystem.stat('/statdir');
      expect(stat.type).toBe('dir');
    });

    it('should check file existence', async () => {
      await fs.promises.writeFile('/exists.txt', 'yes');
      const fileSystem = fromZenFS(fs);

      expect(await fileSystem.exists('/exists.txt')).toBe(true);
      expect(await fileSystem.exists('/nope.txt')).toBe(false);
    });

    it('should scope operations to rootPath', async () => {
      await fs.promises.mkdir('/root', { recursive: true });
      await fs.promises.writeFile('/root/scoped.txt', 'scoped data');
      const fileSystem = fromZenFS(fs, '/root');

      const content = await fileSystem.readFile('/scoped.txt', 'utf8');
      expect(content).toBe('scoped data');
    });
  });

  describe('fromMemoryFS', () => {
    it('should mkdir and create all parent directories', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/a/b/c');

      expect(await fileSystem.exists('/a/b/c')).toBe(true);
      expect(await fileSystem.exists('/a/b')).toBe(true);
      expect(await fileSystem.exists('/a')).toBe(true);
    });

    it('should make parent directories visible via stat', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/x/y/z');

      const statX = await fileSystem.stat('/x');
      expect(statX.type).toBe('dir');

      const statXy = await fileSystem.stat('/x/y');
      expect(statXy.type).toBe('dir');
    });

    it('should list children created by mkdir in readdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/parent/child');

      const entries = await fileSystem.readdir('/parent');
      expect(entries).toContain('child');
    });

    it('should list deeply nested mkdir directories via readdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/a/b/c/d');

      expect(await fileSystem.readdir('/a')).toContain('b');
      expect(await fileSystem.readdir('/a/b')).toContain('c');
      expect(await fileSystem.readdir('/a/b/c')).toContain('d');
    });

    it('should read and write files in directories created by mkdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/project/src');
      await fileSystem.writeFile('/project/src/index.ts', 'export {}');

      const content = await fileSystem.readFile('/project/src/index.ts', 'utf8');
      expect(content).toBe('export {}');
    });
  });

  describe('fromProxy', () => {
    it('should delegate all methods to the target', async () => {
      const target = {
        readFile: vi.fn().mockResolvedValue('content'),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockResolvedValue(['a.txt']),
        unlink: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockResolvedValue({ type: 'file' as const, size: 10, mtimeMs: 1000 }),
        exists: vi.fn().mockResolvedValue(true),
      };

      const fileSystem = fromProxy(target);

      await fileSystem.readFile('/test.txt', 'utf8');
      expect(target.readFile).toHaveBeenCalledWith('/test.txt', 'utf8');

      await fileSystem.writeFile('/out.txt', 'data');
      expect(target.writeFile).toHaveBeenCalledWith('/out.txt', 'data');

      await fileSystem.mkdir('/dir', { recursive: true });
      expect(target.mkdir).toHaveBeenCalledWith('/dir', { recursive: true });

      const entries = await fileSystem.readdir('/');
      expect(entries).toEqual(['a.txt']);

      await fileSystem.unlink('/gone.txt');
      expect(target.unlink).toHaveBeenCalledWith('/gone.txt');

      const stat = await fileSystem.stat('/file.txt');
      expect(stat).toEqual({ type: 'file', size: 10, mtimeMs: 1000 });

      const exists = await fileSystem.exists('/file.txt');
      expect(exists).toBe(true);
    });

    it('should produce arrow functions that do not pass this context', async () => {
      const target = {
        readFile: vi.fn().mockResolvedValue('ok'),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockResolvedValue([]),
        unlink: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockResolvedValue({ type: 'file' as const, size: 0, mtimeMs: 0 }),
        exists: vi.fn().mockResolvedValue(false),
      };

      const fileSystem = fromProxy(target);

      // Destructure to verify functions work without `this` binding
      const { writeFile, mkdir, readdir, unlink, stat, exists } = fileSystem;
      await writeFile('/a.txt', 'data');
      await mkdir('/d');
      await readdir('/');
      await unlink('/a.txt');
      await stat('/a.txt');
      await exists('/a.txt');

      expect(target.writeFile).toHaveBeenCalled();
      expect(target.mkdir).toHaveBeenCalled();
      expect(target.readdir).toHaveBeenCalled();
      expect(target.unlink).toHaveBeenCalled();
      expect(target.stat).toHaveBeenCalled();
      expect(target.exists).toHaveBeenCalled();
    });
  });
});
