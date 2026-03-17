import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFileManager } from '#hooks/use-file-manager.js';

// eslint-disable-next-line no-empty-function -- intentional no-op for unsubscribe fallback
const noop = (): void => {};

/**
 * Auto-loading hook for file content. Uses `useSyncExternalStore` for
 * targeted re-renders when the specific path's content changes.
 *
 * On cache miss, automatically triggers `contentService.resolve()` which
 * reads from the worker and populates the cache, causing a re-render
 * with the loaded content.
 */
export function useFileContent(path: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  const { contentService } = useFileManager();

  const content = useSyncExternalStore(
    useCallback((callback: () => void) => contentService?.subscribe(path, callback) ?? noop, [contentService, path]),
    useCallback(() => (path ? contentService?.peek(path) : undefined), [contentService, path]),
    () => undefined,
  );

  useEffect(() => {
    if (path && content === undefined && contentService) {
      void contentService.resolve(path);
    }
  }, [contentService, path, content]);

  return content;
}
