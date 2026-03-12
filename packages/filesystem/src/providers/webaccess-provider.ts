import { WebAccess } from '@zenfs/dom';
import type { FileSystemProvider } from '#types.js';
import { createZenFsProvider } from '#providers/create-zenfs-provider.js';

/**
 * Create a persistent filesystem provider using the File System Access API.
 *
 * @param handle - Browser directory handle obtained from `showDirectoryPicker()`.
 * @returns Provider backed by ZenFS `WebAccess` backend.
 *
 * @public
 * @example <caption>Mounting a browser directory</caption>
 * ```typescript
 * import { createWebAccessProvider } from '@taucad/filesystem/providers';
 *
 * const rootHandle = await navigator.storage.getDirectory();
 * const provider = await createWebAccessProvider(rootHandle);
 * ```
 */
export const createWebAccessProvider = async (handle: FileSystemDirectoryHandle): Promise<FileSystemProvider> =>
  createZenFsProvider({
    id: 'webaccess',
    capabilities: { persistent: true, writable: true, quotaBased: false },
    backendConfig: { backend: WebAccess, handle },
  });
