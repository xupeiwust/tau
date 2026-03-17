import { useMemo } from 'react';
import { useFileTreeMap } from '#hooks/use-file-tree.js';

type PreviewFileEntry = {
  path: string;
  name: string;
  size: number;
};

/**
 * Hook to read the file list from the file manager for the preview route.
 */
export function usePreviewFileList(): PreviewFileEntry[] {
  const fileTree = useFileTreeMap();

  return useMemo(() => {
    if (fileTree.size === 0) {
      return [];
    }

    return [...fileTree.values()].map((entry) => ({
      path: entry.path,
      name: entry.name,
      size: entry.size,
    }));
  }, [fileTree]);
}
