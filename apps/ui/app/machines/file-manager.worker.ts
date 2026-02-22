import { expose } from 'comlink';
import { fileManager } from '#machines/file-manager.js';
import type { FileManager } from '#machines/file-manager.js';
import { exposeFileSystem } from '@taucad/kernels/filesystem';
import { fromZenFS } from '@taucad/kernels';
import { fs } from '#filesystem/zenfs-config.js';

expose(fileManager);
exposeFileSystem(fromZenFS(fs));

export type FileWorker = FileManager;
