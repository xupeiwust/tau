import type { FileStatus } from '@taucad/types';

// ============================================================================
// File Types (moved from file-explorer.machine.ts)
// ============================================================================

/**
 * Represents an open file tab in the editor.
 */
export type OpenFile = {
  path: string;
  name: string;
};

/**
 * Source of a file open event.
 * - 'user': User-initiated action (e.g., clicked on file in tree, breadcrumb, link) - should open editor panel
 * - 'machine': Programmatic action (e.g., build load, chat tool) - should not auto-open editor panel
 */
export type FileOpenSource = 'user' | 'machine';

/**
 * Represents a file or directory item in the file tree.
 */
export type FileItem = {
  id: string;
  name: string;
  path: string;
  content: Uint8Array<ArrayBuffer>;
  language?: string;
  isDirectory?: boolean;
  children?: FileItem[];
  gitStatus?: FileStatus;
};

// ============================================================================
// Editor State Types
// ============================================================================

/**
 * Editor State - Transient per-build Editor state stored separately from build data.
 *
 * This type is stored in IndexedDB and managed by the editorMachine.
 * It is decoupled from the Build type to keep the build machine clean for
 * CLI/multi-frontend reuse.
 */
export type EditorState = {
  /** Primary key, references Build.id */
  buildId: string;
  /** Open files/tabs in the editor */
  openFiles: OpenFile[];
  /** Currently active file path */
  activeFilePath: string | undefined;
  /** Last active chat ID */
  lastChatId: string | undefined;
  /** Timestamp of last update */
  updatedAt: number;
};

/**
 * Input type for updating editor state.
 * The `updatedAt` field is omitted as it's automatically set by the storage layer.
 */
export type EditorStateInput = Omit<EditorState, 'updatedAt'>;
