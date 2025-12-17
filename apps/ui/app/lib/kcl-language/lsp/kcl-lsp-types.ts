/**
 * Shared types for KCL LSP communication.
 */

/**
 * Worker event types for LSP communication.
 */
export enum LspWorkerEventType {
  Init = 'init',
  Call = 'call',
}

/**
 * Worker type identifier.
 */
export const kclWorkerType = 'kcl-lsp';

/**
 * Options for initializing the KCL LSP worker.
 */
export type KclLspWorkerOptions = {
  /** URL to the WASM file */
  wasmUrl: string;
  /** Authentication token (empty for offline mode) */
  token: string;
  /** API base URL (empty for offline mode) */
  apiBaseUrl: string;
};

/**
 * Event sent to/from the LSP worker.
 */
export type LspWorkerEvent = {
  worker: string;
  eventType: LspWorkerEventType;
  eventData: Uint8Array | KclLspWorkerOptions;
};

/**
 * Semantic token types supported by the KCL LSP.
 * Must match the order in the server's SemanticTokensLegend.
 */
export const semanticTokenTypes = [
  'number',
  'variable',
  'keyword',
  'type',
  'string',
  'operator',
  'comment',
  'function',
  'parameter',
  'property',
] as const;

/**
 * Semantic token modifiers supported by the KCL LSP.
 */
export const semanticTokenModifiers = ['declaration', 'definition', 'defaultLibrary', 'readonly', 'static'] as const;
