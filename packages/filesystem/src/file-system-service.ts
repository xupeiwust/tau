/**
 * Layer 2 of the filesystem architecture: the only seam consumers see.
 *
 * `FileSystemService` owns mount routing (delegated to {@link MountTable}),
 * watch fan-out (delegated to {@link WatchRegistry}), and an optional content
 * cache. It exposes {@link asProvider} and {@link asRuntimeFileSystem} facades
 * so kernels and downstream consumers can talk to a uniform shape regardless
 * of the underlying mount topology.
 */

import type { FileStat, FileStatEntry } from '@taucad/types';
import { ChangeEventBus } from '#change-event-bus.js';
import { MountTable } from '#mount-table.js';
import type { MountConfig } from '#mount-table.js';
import { WatchRegistry } from '#watch-registry.js';
import type {
  ChangeEvent,
  FileContentCache,
  FileSystemProvider,
  ProviderCapabilities,
  RuntimeFileSystem,
  WatchEvent,
  WatchRequest,
} from '#types.js';

/**
 * Options for {@link createFileSystemService}.
 * @public
 */
export type FileSystemServiceOptions = {
  /** Optional content cache that short-circuits reads and is invalidated on writes. */
  cache?: FileContentCache;
  /**
   * Optional shared {@link MountTable}. When provided, callers can query the
   * mount topology directly (e.g. via {@link MountTable.getMountsUnder}). When
   * omitted the service owns a private table.
   */
  mountTable?: MountTable;
  /**
   * Optional shared {@link ChangeEventBus}. When provided, watch events
   * dispatched by the service are visible to other consumers of the bus
   * (cross-tab coordinator, external watchers).
   */
  eventBus?: ChangeEventBus;
};

/**
 * Layer 2 consumer surface. Routes requests through the mount table, fans out
 * watches via a shared {@link ChangeEventBus}, and exposes provider /
 * runtime facades.
 * @public
 */
export type FileSystemService = {
  /**
   * Attach a provider at `prefix`. Returns a disposable that detaches the
   * mount on dispose.
   *
   * @param prefix - Absolute path prefix to mount at.
   * @param provider - Backend provider.
   * @param config - Optional mount metadata (backend kind, preservePath).
   */
  mount(prefix: string, provider: FileSystemProvider, config?: MountConfig): { dispose: () => void };
  /** Detach the provider currently mounted at `prefix`. */
  unmount(prefix: string): void;

  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;

  /** Subscribe to filesystem change events scoped by `request`. */
  watch(request: WatchRequest, handler: (event: WatchEvent) => void): { dispose: () => void };

  /**
   * Publish a {@link ChangeEvent} into the underlying change bus. Backends
   * and integration points (cross-tab sync, external watchers) call this to
   * notify watchers.
   */
  publishChangeEvent(event: ChangeEvent): void;

  /** Return a {@link FileSystemProvider} facade backed by this service. */
  asProvider(): FileSystemProvider;
  /** Return a {@link RuntimeFileSystem} kernel facade backed by this service. */
  asRuntimeFileSystem(): RuntimeFileSystem;

  dispose(): void;
};

const serviceCapabilities: ProviderCapabilities = {
  persistent: true,
  writable: true,
  quotaBased: false,
  caseSensitive: true,
};

/**
 * Construct a {@link FileSystemService}. Mounts are added via {@link FileSystemService.mount}.
 *
 * @param options - Service configuration including the optional content cache.
 * @returns A new {@link FileSystemService} instance.
 * @public
 */
export const createFileSystemService = (options: FileSystemServiceOptions = {}): FileSystemService => {
  const ownsMountTable = !options.mountTable;
  const ownsEventBus = !options.eventBus;
  const mountTable = options.mountTable ?? new MountTable();
  const eventBus = options.eventBus ?? new ChangeEventBus();
  const watchRegistry = new WatchRegistry(eventBus);
  const { cache } = options;

  let cacheInvalidateSub: { dispose: () => void } | undefined;
  if (cache) {
    cacheInvalidateSub = cache.on('invalidate', () => {
      // Invalidation events surface upstream listeners via the change bus
      // when downstream consumers rely on cache coherency. The current
      // implementation keeps the hook in place for forward-compat with
      // shared-pool caches.
    });
  }

  const mount = (prefix: string, provider: FileSystemProvider, config?: MountConfig): { dispose: () => void } => {
    mountTable.mount(prefix, provider, config ?? { backend: 'memory' });
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        mountTable.unmount(prefix);
      },
    };
  };

  const unmount = (prefix: string): void => {
    mountTable.unmount(prefix);
  };

  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    if (encoding === 'utf8') {
      const bytes = await readFileBytes(path);
      return new TextDecoder().decode(bytes);
    }
    return readFileBytes(path);
  }

  const readFileBytes = async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
    if (cache) {
      const cached = cache.get(path);
      if (cached) {
        return cached;
      }
    }
    const { provider, path: providerPath } = mountTable.resolve(path);
    const bytes = await provider.readFile(providerPath);
    cache?.put(path, bytes);
    return bytes;
  };

  const writeFile = async (path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    await provider.writeFile(providerPath, data);
    cache?.invalidate(path);
  };

  const readdir = async (path: string): Promise<string[]> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    return provider.readdir(providerPath);
  };

  const stat = async (path: string): Promise<FileStat> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    return provider.stat(providerPath);
  };

  const lstat = async (path: string): Promise<FileStat> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    return provider.lstat(providerPath);
  };

  const mkdir = async (path: string, mkdirOptions?: { recursive?: boolean }): Promise<void> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    await provider.mkdir(providerPath, mkdirOptions);
  };

  const unlink = async (path: string): Promise<void> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    await provider.unlink(providerPath);
    cache?.invalidate(path);
  };

  const rmdir = async (path: string): Promise<void> => {
    const { provider, path: providerPath } = mountTable.resolve(path);
    await provider.rmdir(providerPath);
  };

  const rename = async (from: string, to: string): Promise<void> => {
    const { provider, path: providerPath } = mountTable.resolve(from);
    const target = mountTable.resolve(to);
    if (target.provider !== provider) {
      throw new Error(`[FileSystemService] Cross-mount rename is not supported: ${from} -> ${to}`);
    }
    await provider.rename(providerPath, target.path);
    cache?.invalidate(from);
    cache?.invalidate(to);
  };

  const exists = async (path: string): Promise<boolean> => {
    try {
      const { provider, path: providerPath } = mountTable.resolve(path);
      return await provider.exists(providerPath);
    } catch {
      return false;
    }
  };

  const watch = (request: WatchRequest, handler: (event: WatchEvent) => void): { dispose: () => void } => {
    const unsubscribe = watchRegistry.watch(request, handler);
    return { dispose: unsubscribe };
  };

  const publishChangeEvent = (event: ChangeEvent): void => {
    eventBus.emit(event);
  };

  const dispose = (): void => {
    cacheInvalidateSub?.dispose();
    watchRegistry.dispose();
    if (ownsEventBus) {
      eventBus.dispose();
    }
    if (ownsMountTable) {
      mountTable.dispose();
    }
  };

  let providerFacade: FileSystemProvider | undefined;
  let runtimeFacade: RuntimeFileSystem | undefined;

  const asProvider = (): FileSystemProvider => {
    if (providerFacade) {
      return providerFacade;
    }

    function facadeReadFile(p: string): Promise<Uint8Array<ArrayBuffer>>;
    function facadeReadFile(p: string, encoding: 'utf8'): Promise<string>;
    async function facadeReadFile(p: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
      return encoding === 'utf8' ? readFile(p, 'utf8') : readFile(p);
    }

    providerFacade = {
      id: 'filesystem-service',
      capabilities: serviceCapabilities,
      readFile: facadeReadFile,
      writeFile,
      readdir,
      stat,
      mkdir,
      unlink,
      rmdir,
      rename,
      exists,
      lstat,
      dispose: () => undefined,
    };

    return providerFacade;
  };

  const asRuntimeFileSystem = (): RuntimeFileSystem => {
    if (runtimeFacade) {
      return runtimeFacade;
    }

    const provider = asProvider();

    const readFiles = async (paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>> => {
      const entries = await Promise.all(paths.map(async (p) => [p, await readFile(p)] as const));
      return Object.fromEntries(entries);
    };

    const readdirContents = async (directoryPath: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> => {
      const names = await readdir(directoryPath);
      const entries = await Promise.all(
        names.map(async (name) => {
          const fullPath = directoryPath.endsWith('/') ? `${directoryPath}${name}` : `${directoryPath}/${name}`;
          const entryStat = await stat(fullPath);
          if (entryStat.type === 'dir') {
            return undefined;
          }
          return [name, await readFile(fullPath)] as const;
        }),
      );
      return Object.fromEntries(
        entries.filter((entry): entry is readonly [string, Uint8Array<ArrayBuffer>] => entry !== undefined),
      );
    };

    const readdirStat = async (directoryPath: string): Promise<FileStatEntry[]> => {
      const names = await readdir(directoryPath);
      const entries = await Promise.all(
        names.map(async (name): Promise<FileStatEntry> => {
          const fullPath = directoryPath.endsWith('/') ? `${directoryPath}${name}` : `${directoryPath}/${name}`;
          const entryStat = await stat(fullPath);
          return { ...entryStat, name, path: fullPath };
        }),
      );
      return entries;
    };

    const ensureDirectory = async (path: string): Promise<void> => {
      try {
        const existing = await stat(path);
        if (existing.type === 'dir') {
          return;
        }
      } catch {
        // Falls through to mkdir.
      }
      await mkdir(path, { recursive: true });
    };

    runtimeFacade = {
      ...provider,
      watch,
      readFiles,
      readdirContents,
      readdirStat,
      ensureDir: ensureDirectory,
    };

    return runtimeFacade;
  };

  return {
    mount,
    unmount,
    readFile,
    writeFile,
    readdir,
    stat,
    lstat,
    mkdir,
    unlink,
    rmdir,
    rename,
    exists,
    watch,
    publishChangeEvent,
    asProvider,
    asRuntimeFileSystem,
    dispose,
  };
};

/**
 * Identity helper that preserves the literal type of `options` for downstream
 * inference when registering a service via configuration objects.
 *
 * @param options - Options object forwarded to {@link createFileSystemService}.
 * @returns The same `options` object with its inferred literal type preserved.
 * @public
 */
export const createFileSystemServiceOptions = <T extends FileSystemServiceOptions>(options: T): T => options;
