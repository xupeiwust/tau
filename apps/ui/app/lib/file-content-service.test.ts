import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileContentService } from '#lib/file-content-service.js';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { ContentChangeEvent } from '#lib/file-content-service.js';

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
    dispose: vi.fn(),
    ...overrides,
  } as unknown as FileManagerProxy;
}

describe('FileContentService', () => {
  let proxy: FileManagerProxy;
  let service: FileContentService;

  beforeEach(() => {
    proxy = createMockProxy();
    service = new FileContentService({
      proxy,
      rootDirectory: '/project',
    });
  });

  it('should resolve content from worker on cache miss', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    const result = await service.resolve('main.ts');

    expect(proxy.readFile).toHaveBeenCalledWith('/project/main.ts');
    expect(result).toEqual(data);
  });

  it('should return cached content without worker call on cache hit', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('main.ts');
    vi.mocked(proxy.readFile).mockClear();

    const result = await service.resolve('main.ts');

    expect(proxy.readFile).not.toHaveBeenCalled();
    expect(result).toEqual(data);
  });

  it('should join pending resolves for concurrent reads of same path', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    const [result1, result2] = await Promise.all([service.resolve('main.ts'), service.resolve('main.ts')]);

    expect(proxy.readFile).toHaveBeenCalledTimes(1);
    expect(result1).toBe(result2);
  });

  it('should clone buffer before transfer on write, keeping valid local copy', async () => {
    const original = new Uint8Array([1, 2, 3]);

    await service.write('main.ts', original, 'machine');

    expect(proxy.writeFile).toHaveBeenCalledWith('/project/main.ts', original);

    const cached = service.peek('main.ts');
    expect(cached).toBeDefined();
    expect(cached).toEqual(new Uint8Array([1, 2, 3]));
    expect(cached).not.toBe(original);
  });

  it('should fire onDidContentChange with valid data after write', async () => {
    const handler = vi.fn<(event: ContentChangeEvent) => void>();
    service.onDidContentChange(handler);

    const data = new Uint8Array([1, 2, 3]);
    await service.write('main.ts', data, 'editor');

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]![0];
    expect(event.type).toBe('written');
    if (event.type === 'written') {
      expect(event.path).toBe('main.ts');
      expect(event.source).toBe('editor');
      expect(event.data.byteLength).toBe(3);
    }
  });

  it('should update cache on rename', async () => {
    const data = new Uint8Array([1, 2, 3]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('old.ts');
    await service.rename('old.ts', 'new.ts');

    expect(service.has('old.ts')).toBe(false);
    expect(service.has('new.ts')).toBe(true);
    expect(service.peek('new.ts')).toEqual(data);
  });

  it('should fire content change on delete', async () => {
    const handler = vi.fn<(event: ContentChangeEvent) => void>();
    service.onDidContentChange(handler);

    const data = new Uint8Array([1]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);
    await service.resolve('main.ts');

    handler.mockClear();

    await service.delete('main.ts', 'user');

    expect(service.has('main.ts')).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].type).toBe('deleted');
  });

  it('should return data without LRU promotion via peek()', async () => {
    const data = new Uint8Array([1]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('main.ts');

    const peeked = service.peek('main.ts');
    expect(peeked).toEqual(data);
  });

  it('should clone each file buffer on writeFiles', async () => {
    const file1 = new Uint8Array([1, 2]);
    const file2 = new Uint8Array([3, 4]);

    const filePathA = 'a.ts';
    const filePathB = 'b.ts';
    await service.writeFiles({ [filePathA]: { content: file1 }, [filePathB]: { content: file2 } }, 'machine');

    expect(proxy.writeFiles).toHaveBeenCalledOnce();

    const cachedA = service.peek('a.ts');
    const cachedB = service.peek('b.ts');
    expect(cachedA).toEqual(new Uint8Array([1, 2]));
    expect(cachedB).toEqual(new Uint8Array([3, 4]));
    expect(cachedA).not.toBe(file1);
    expect(cachedB).not.toBe(file2);
  });

  it('should notify path subscribers on write', async () => {
    const callback = vi.fn();
    service.subscribe('main.ts', callback);

    await service.write('main.ts', new Uint8Array([1]), 'user');

    expect(callback).toHaveBeenCalledOnce();
  });

  it('should notify path subscribers on resolve (cache population)', async () => {
    const callback = vi.fn();
    service.subscribe('main.ts', callback);

    vi.mocked(proxy.readFile).mockResolvedValue(new Uint8Array([1]));
    await service.resolve('main.ts');

    expect(callback).toHaveBeenCalledOnce();
  });

  it('should call proxy.copyDirectory for copyDirectory', async () => {
    await service.copyDirectory('/src', '/dest');

    expect(proxy.copyDirectory).toHaveBeenCalledWith('/src', '/dest');
  });

  it('should call proxy.getZippedDirectory for getZippedDirectory', async () => {
    const blob = new Blob(['zip']);
    vi.mocked(proxy.getZippedDirectory).mockResolvedValue(blob);

    const result = await service.getZippedDirectory('/project');

    expect(proxy.getZippedDirectory).toHaveBeenCalledWith('/project');
    expect(result).toBe(blob);
  });
});
