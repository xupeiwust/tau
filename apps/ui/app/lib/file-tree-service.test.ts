import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileTreeService } from '#lib/file-tree-service.js';
import { FileContentService } from '#lib/file-content-service.js';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { FileEntry } from '@taucad/types';

function createMockProxy(overrides?: Partial<FileManagerProxy>): FileManagerProxy {
  return {
    readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    copyDirectory: vi.fn().mockResolvedValue(undefined),
    getZippedDirectory: vi.fn().mockResolvedValue(new Blob()),
    duplicateFile: vi.fn().mockResolvedValue(undefined),
    getDirectoryStat: vi.fn().mockResolvedValue([]),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, mtimeMs: 0 }),
    rmdir: vi.fn().mockResolvedValue(undefined),
    readShallowDirectory: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as FileManagerProxy;
}

function createEntry(path: string, type: 'file' | 'dir' = 'file', size = 100): FileEntry {
  const parts = path.split('/');
  return { path, name: parts.at(-1) ?? path, type, size, mtimeMs: 0, isLoaded: false };
}

describe('FileTreeService', () => {
  let proxy: FileManagerProxy;
  let service: FileTreeService;

  beforeEach(() => {
    vi.useFakeTimers();
    proxy = createMockProxy();
    service = new FileTreeService({
      proxy,
      rootDirectory: '/project',
      initialEntries: [createEntry('main.ts'), createEntry('lib/utils.ts'), createEntry('lib/helpers.ts')],
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it('should return tree snapshot with stable reference when unchanged', () => {
    const snap1 = service.getTreeSnapshot();
    const snap2 = service.getTreeSnapshot();
    expect(snap1).toBe(snap2);
  });

  it('should return true from exists() for known paths', () => {
    expect(service.exists('main.ts')).toBe(true);
    expect(service.exists('lib/utils.ts')).toBe(true);
    expect(service.exists('unknown.ts')).toBe(false);
  });

  it('should return entries from readdir() matching parent path', async () => {
    const entries = await service.readdir('lib');
    expect(entries).toContain('utils.ts');
    expect(entries).toContain('helpers.ts');
    expect(entries).not.toContain('main.ts');
  });

  it('should debounce refresh when rapid mutations occur', async () => {
    service.scheduleRefresh('lib');
    service.scheduleRefresh('lib');
    service.scheduleRefresh('lib');

    await vi.advanceTimersByTimeAsync(200);
    expect(proxy.getDirectoryStat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(proxy.getDirectoryStat).toHaveBeenCalledOnce();
  });

  it('should refresh only the changed files parent directory', async () => {
    vi.useRealTimers();

    const localProxy = createMockProxy({
      getDirectoryStat: vi.fn().mockResolvedValue([
        { path: 'utils.ts', name: 'utils.ts', type: 'file', size: 200, mtimeMs: 0 },
        { path: 'helpers.ts', name: 'helpers.ts', type: 'file', size: 200, mtimeMs: 0 },
        { path: 'new-file.ts', name: 'new-file.ts', type: 'file', size: 50, mtimeMs: 0 },
      ]),
    });
    const localService = new FileTreeService({
      proxy: localProxy,
      rootDirectory: '/project',
      initialEntries: [createEntry('main.ts'), createEntry('lib/utils.ts'), createEntry('lib/helpers.ts')],
      debounceMs: 10,
    });

    localService.scheduleRefresh('lib');

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(localProxy.getDirectoryStat).toHaveBeenCalledWith('/project/lib');
    expect(localService.exists('lib/new-file.ts')).toBe(true);
    expect(localService.exists('main.ts')).toBe(true);

    localService.dispose();
    vi.useFakeTimers();
  });

  it('should skip tree refresh for source=editor content changes', () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });

    service.connectToContentService(contentService);

    vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
    void contentService.write('main.ts', new Uint8Array([1]), 'editor');

    // eslint-disable-next-line @typescript-eslint/dot-notation -- accessing private member in test
    expect(service['refreshTimer']).toBeUndefined();

    contentService.dispose();
  });

  it('should apply optimistic tree update on content written event', async () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
    await contentService.write('newfile.ts', new Uint8Array([1, 2, 3]), 'machine');

    expect(service.exists('newfile.ts')).toBe(true);
    const entry = service.getEntry('newfile.ts');
    expect(entry?.type).toBe('file');
    expect(entry?.size).toBe(3);

    contentService.dispose();
  });

  it('should apply optimistic tree update on content deleted event', async () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    expect(service.exists('main.ts')).toBe(true);

    vi.mocked(contentProxy.unlink).mockResolvedValue(undefined);
    await contentService.delete('main.ts', 'user');

    expect(service.exists('main.ts')).toBe(false);

    contentService.dispose();
  });

  it('should apply optimistic tree update on content renamed event', async () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    vi.mocked(contentProxy.rename).mockResolvedValue(undefined);
    await contentService.rename('main.ts', 'app.ts');

    expect(service.exists('main.ts')).toBe(false);
    expect(service.exists('app.ts')).toBe(true);

    contentService.dispose();
  });

  it('should notify subscribers when tree changes', async () => {
    const subscriber = vi.fn();
    service.subscribeTree(subscriber);

    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
    await contentService.write('new.ts', new Uint8Array([1]), 'user');

    expect(subscriber).toHaveBeenCalled();

    contentService.dispose();
  });
});
