import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Workspace-root-relative cache dir shared by `vite-plugin-mkcert` and `pnpm nx serve ui --https`. */
const tauWorkspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

export const httpsCertsSavePath = path.join(tauWorkspaceRoot, 'node_modules', '.cache', 'vite-plugin-mkcert');

export const httpsCaPemFilename = 'rootCA.pem';

export const httpsCaPemPath = path.join(httpsCertsSavePath, httpsCaPemFilename);

export const httpsCertPemFilename = 'dev.pem';

export const httpsKeyPemFilename = 'dev.key';

export const httpsCertPemPath = path.join(httpsCertsSavePath, httpsCertPemFilename);

export const httpsKeyPemPath = path.join(httpsCertsSavePath, httpsKeyPemFilename);
