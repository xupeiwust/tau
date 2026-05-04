import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  type DirectoryListing,
  type DirectoryListingError,
  DirectoryListingFailedError,
  classifyDirectoryListingError,
} from '#directory-listing.js';
import type { FileTreeService } from '#file-tree-service.js';

type ListingStore = {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => DirectoryListing;
  emit: (next: DirectoryListing) => void;
};

const createListingStore = (): ListingStore => {
  let snapshot: DirectoryListing = { kind: 'unready' };
  const listeners = new Set<() => void>();
  return {
    subscribe(onStoreChange: () => void) {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    getSnapshot(): DirectoryListing {
      return snapshot;
    },
    emit(next: DirectoryListing) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const serverSnapshot: DirectoryListing = { kind: 'unready' };

function listingErrorFromUnknown(cause: unknown, path: string): DirectoryListingError {
  if (cause instanceof DirectoryListingFailedError) {
    return cause.listing;
  }
  return classifyDirectoryListingError(cause, path);
}

/**
 * @public
 */
export type UseDirectoryListingOptions = {
  /**
   * Increment (or any monotonic change) to re-run a cold load after `kind: 'error'`
   * without changing the path (e.g. user pressed Retry).
   */
  reloadToken?: number;
};

/**
 * React binding for {@link FileTreeService.listDirectory}: keeps a
 * {@link DirectoryListing} snapshot in sync via `useSyncExternalStore` and
 * `subscribePath`, cold-loads unresolved directories with an `AbortController`
 * tied to the `(treeService, path)` dependency tuple.
 *
 * @param treeService - File tree facade, or `undefined` when the file manager is not mounted.
 * @param path - Directory path (workspace-relative; root aliases accepted by the tree service).
 * @param options - Optional {@link UseDirectoryListingOptions.reloadToken} for explicit retry.
 *
 * @public
 */
export function useDirectoryListing(
  treeService: FileTreeService | undefined,
  path: string,
  options?: UseDirectoryListingOptions,
): DirectoryListing {
  const reloadToken = options?.reloadToken ?? 0;
  const store = useMemo(() => {
    const listingStore = createListingStore();
    if (!treeService) {
      listingStore.emit({ kind: 'unready' });
    } else {
      const sync = treeService.listDirectorySync(path);
      if (sync !== undefined) {
        listingStore.emit({ kind: 'ready', path, entries: sync });
      } else {
        listingStore.emit({ kind: 'loading', path });
      }
    }
    return listingStore;
  }, [treeService, path]);

  const listing = useSyncExternalStore(store.subscribe, store.getSnapshot, () => serverSnapshot);

  useEffect(() => {
    if (!treeService) {
      return;
    }

    return treeService.subscribePath(path, () => {
      const next = treeService.listDirectorySync(path);
      if (next !== undefined) {
        store.emit({ kind: 'ready', path, entries: next });
      }
    });
  }, [store, treeService, path]);

  useEffect(() => {
    if (!treeService) {
      return;
    }

    if (treeService.listDirectorySync(path) !== undefined) {
      return;
    }

    store.emit({ kind: 'loading', path });

    const abortController = new AbortController();
    const { signal } = abortController;

    void treeService.listDirectory(path, { signal }).then(
      (entries) => {
        if (signal.aborted) {
          return;
        }
        store.emit({ kind: 'ready', path, entries });
      },
      (cause: unknown) => {
        if (signal.aborted) {
          return;
        }
        store.emit({ kind: 'error', path, cause: listingErrorFromUnknown(cause, path) });
      },
    );

    return () => {
      abortController.abort();
    };
  }, [store, treeService, path, reloadToken]);

  return listing;
}
