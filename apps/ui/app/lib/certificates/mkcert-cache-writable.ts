import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Mkcert persists `rootCA-key.pem` with `0400` permissions; regenerating certs then fails with EPERM /
 * permission denied unless we widen owner write bits before vite-plugin-mkcert re-runs `mkcert -install`.
 *
 * Applies to incremental regen triggered by LAN IP churn (Nx `runtime` bootstrap input).
 */
export const ensureMkcertCacheWritableForRegeneration = (savePath: string): void => {
  const entries = [
    { fileName: 'rootCA-key.pem', mode: 0o600 },
    { fileName: 'rootCA.pem', mode: 0o644 },
    { fileName: 'dev.key', mode: 0o600 },
    { fileName: 'dev.pem', mode: 0o644 },
  ] as const;

  for (const { fileName, mode } of entries) {
    const absolutePath = path.join(savePath, fileName);
    if (!existsSync(absolutePath)) {
      continue;
    }

    chmodSync(absolutePath, mode);
  }
};
