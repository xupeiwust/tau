import type { FileEntry, FileStatEntry, FileSystemBackend, FileStat } from '@taucad/types';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { FileTreeNode } from '@taucad/filesystem';
import type { FileContentService, ContentChangeEvent } from '#lib/file-content-service.js';
import { normalizePath, joinPath, joinRelativePath } from '@taucad/utils/path';

const defaultDebounceMs = 300;
const watchIntervalFocusedMs = 2000;
const watchIntervalBlurredMs = 10_000;

type FileTreeServiceInit = {
  proxy: FileManagerProxy;
  rootDirectory: string;
  initialEntries?: FileEntry[];
  debounceMs?: number;
};

/**
 * Single tree/metadata authority on the main thread.
 * All tree reads, directory listings, existence checks, and stat operations
 * go through this service. Owns the fileTree Map (removed from machine context).
 */
export class FileTreeService {
  private _tree: Map<string, FileEntry>;
  private readonly proxy: FileManagerProxy;
  private rootDirectory: string;
  private readonly treeSubscribers = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRefreshPath = '';
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private contentUnsubscribe: (() => void) | undefined;
  private visibilityHandler: (() => void) | undefined;
  private readonly debounceMs: number;

  public constructor(init: FileTreeServiceInit) {
    this.proxy = init.proxy;
    this.rootDirectory = init.rootDirectory;
    this.debounceMs = init.debounceMs ?? defaultDebounceMs;
    this._tree = new Map();
    if (init.initialEntries) {
      for (const entry of init.initialEntries) {
        this._tree.set(entry.path, entry);
      }
    }
  }

  // === Tree Access (sync, from cache) ===

  /**
   * Returns the current tree Map. Stable reference when unchanged.
   * Required by `useSyncExternalStore`.
   */
  public getTreeSnapshot(): Map<string, FileEntry> {
    return this._tree;
  }

  /**
   * Get a single entry by path.
   */
  public getEntry(path: string): FileEntry | undefined {
    return this._tree.get(path);
  }

  /**
   * Check if a path exists in the tree. Sync, no worker roundtrip.
   */
  public exists(path: string): boolean {
    return this._tree.has(path);
  }

  // === Metadata Operations (async, proxy) ===

  /**
   * List directory contents from the cached tree. Falls back to proxy
   * if tree appears stale or empty.
   */
  public async readdir(path: string): Promise<string[]> {
    const prefix = path === '' ? '' : path.endsWith('/') ? path : `${path}/`;
    const results: string[] = [];

    for (const [entryPath, entry] of this._tree) {
      if (prefix === '') {
        if (!entryPath.includes('/')) {
          results.push(entry.name);
        }
      } else if (entryPath.startsWith(prefix)) {
        const remainder = entryPath.slice(prefix.length);
        if (!remainder.includes('/')) {
          results.push(entry.name);
        }
      }
    }

    if (results.length > 0) {
      return results;
    }

    const absolutePath = joinPath(this.rootDirectory, path);
    return this.proxy.readdir(absolutePath);
  }

  /**
   * Get file stat via proxy.
   */
  public async stat(path: string): Promise<FileStat> {
    const absolutePath = joinPath(this.rootDirectory, path);
    return this.proxy.stat(absolutePath);
  }

  /**
   * Get all file stats in a directory recursively via proxy.
   */
  public async getDirectoryStat(path: string): Promise<FileStatEntry[]> {
    const absolutePath = path === '' ? normalizePath(this.rootDirectory) : joinPath(this.rootDirectory, path);
    return this.proxy.getDirectoryStat(absolutePath);
  }

  /**
   * Read shallow directory for files route.
   */
  public async readShallowDirectory(path: string, backend: FileSystemBackend): Promise<FileTreeNode[]> {
    return this.proxy.readShallowDirectory(path, backend);
  }

  /**
   * Remove a directory via proxy.
   */
  public async rmdir(path: string): Promise<void> {
    const absolutePath = joinPath(this.rootDirectory, path);
    await this.proxy.rmdir(absolutePath);
  }

  // === Refresh Control ===

  /**
   * Debounce tree refresh. Multiple calls coalesce to common ancestor.
   */
  public scheduleRefresh(path: string): void {
    if (this.pendingRefreshPath === '' || path === '') {
      this.pendingRefreshPath = path;
    } else {
      const currentParts = this.pendingRefreshPath.split('/');
      const newParts = path.split('/');
      const commonParts: string[] = [];
      for (let i = 0; i < Math.min(currentParts.length, newParts.length); i++) {
        if (currentParts[i] === newParts[i]) {
          commonParts.push(currentParts[i]!);
        } else {
          break;
        }
      }
      this.pendingRefreshPath = commonParts.join('/');
    }

    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.executeRefresh(this.pendingRefreshPath);
      this.pendingRefreshPath = '';
    }, this.debounceMs);
  }

  // === Polling (WebAccess backend) ===

  public startPolling(): void {
    this.stopPolling();

    const poll = (): void => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document is undefined in SSR/worker
      const interval =
        globalThis.document?.visibilityState === 'visible' ? watchIntervalFocusedMs : watchIntervalBlurredMs;
      this.pollingTimer = setTimeout(() => {
        this.scheduleRefresh('');
        poll();
      }, interval);
    };

    poll();

    this.visibilityHandler = () => {
      this.stopPolling();
      poll();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  public stopPolling(): void {
    if (this.pollingTimer !== undefined) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.visibilityHandler) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.visibilityHandler);
      }
      this.visibilityHandler = undefined;
    }
  }

  // === Content Change Subscription ===

  /**
   * Subscribe to content changes from FileContentService.
   * Skips tree refresh for `source === 'editor'` (editor typing doesn't
   * change tree structure). Otherwise applies optimistic update + schedules
   * debounced refresh.
   */
  public connectToContentService(contentService: FileContentService): void {
    this.contentUnsubscribe?.();
    this.contentUnsubscribe = contentService.onDidContentChange((event) => {
      this.handleContentChange(event);
    });
  }

  // === Worker Push Events ===

  public handleWorkerFileChanged(_event: unknown): void {
    this.scheduleRefresh('');
  }

  // === Tree Subscriptions (useSyncExternalStore) ===

  public subscribeTree(callback: () => void): () => void {
    this.treeSubscribers.add(callback);
    return () => {
      this.treeSubscribers.delete(callback);
    };
  }

  // === Lifecycle ===

  public reset(rootDirectory: string, initialEntries?: FileEntry[]): void {
    this.rootDirectory = rootDirectory;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingRefreshPath = '';

    const newTree = new Map<string, FileEntry>();
    if (initialEntries) {
      for (const entry of initialEntries) {
        newTree.set(entry.path, entry);
      }
    }
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  public dispose(): void {
    this.stopPolling();
    this.contentUnsubscribe?.();
    this.contentUnsubscribe = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.treeSubscribers.clear();
  }

  private notifyTreeSubscribers(): void {
    for (const callback of this.treeSubscribers) {
      callback();
    }
  }

  private handleContentChange(event: ContentChangeEvent): void {
    switch (event.type) {
      case 'written': {
        if (event.source === 'editor') {
          return;
        }
        this.optimisticAdd(event.path, event.data.byteLength);
        this.scheduleRefreshForParent(event.path);
        break;
      }
      case 'deleted': {
        if (event.source === 'editor') {
          return;
        }
        this.optimisticDelete(event.path);
        this.scheduleRefreshForParent(event.path);
        break;
      }
      case 'renamed': {
        this.optimisticRename(event.oldPath, event.newPath);
        this.scheduleRefreshForParent(event.oldPath);
        this.scheduleRefreshForParent(event.newPath);
        break;
      }
      case 'batchWritten': {
        this.scheduleRefresh('');
        break;
      }
      case 'read': {
        break;
      }
    }
  }

  private optimisticAdd(path: string, size: number): void {
    const parts = path.split('/');
    const name = parts.at(-1) ?? path;
    const newTree = new Map(this._tree);
    newTree.set(path, { path, name, type: 'file', size, isLoaded: false });
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  private optimisticDelete(path: string): void {
    if (!this._tree.has(path)) {
      return;
    }
    const newTree = new Map(this._tree);
    newTree.delete(path);
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  private optimisticRename(oldPath: string, newPath: string): void {
    const entry = this._tree.get(oldPath);
    if (!entry) {
      return;
    }
    const parts = newPath.split('/');
    const name = parts.at(-1) ?? newPath;
    const newTree = new Map(this._tree);
    newTree.delete(oldPath);
    newTree.set(newPath, { ...entry, path: newPath, name });
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  private scheduleRefreshForParent(path: string): void {
    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? path.slice(0, lastSlash) : '';
    this.scheduleRefresh(parentPath);
  }

  private async executeRefresh(path: string): Promise<void> {
    try {
      const absolutePath = path === '' ? normalizePath(this.rootDirectory) : joinPath(this.rootDirectory, path);
      const fileStats = await this.proxy.getDirectoryStat(absolutePath);

      const newTree = new Map(this._tree);

      if (path === '') {
        newTree.clear();
      } else {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        for (const key of newTree.keys()) {
          if (key.startsWith(prefix) || key === path) {
            newTree.delete(key);
          }
        }
      }

      for (const stat of fileStats) {
        const entryPath = path === '' ? stat.path : joinRelativePath(path, stat.path);
        newTree.set(entryPath, {
          path: entryPath,
          name: stat.name,
          type: stat.type,
          size: stat.size,
          isLoaded: false,
        });
      }

      this._tree = newTree;
      this.notifyTreeSubscribers();
    } catch (error) {
      console.error('[FileTreeService] refresh failed:', error);
    }
  }
}
