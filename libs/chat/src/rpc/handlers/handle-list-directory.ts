import type { ListDirectoryRpcInput, ListDirectoryRpcResult } from '#schemas/rpc.schema.js';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { toRpcError } from '#rpc/rpc-error.js';

export async function handleListDirectory(
  input: ListDirectoryRpcInput,
  fileSystem: RpcFileSystem,
): Promise<ListDirectoryRpcResult> {
  try {
    const rawEntries = await fileSystem.readdir(input.path);
    const entries = rawEntries.map(
      (entry) =>
        ({
          name: entry.name,
          type: entry.type === 'directory' ? 'dir' : 'file',
          size: entry.size,
        }) as const,
    );

    return { success: true, entries, path: input.path || '/' };
  } catch (error) {
    return toRpcError(error);
  }
}
