import { codeLanguages } from '@taucad/types/constants';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type * as LSP from 'vscode-languageserver-protocol';
import { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { createDiagnosticsHandler } from '#lib/kcl-language/lsp/providers/diagnostics-handler.js';
import { createCompletionProvider } from '#lib/kcl-language/lsp/providers/completion-provider.js';
import { createHoverProvider } from '#lib/kcl-language/lsp/providers/hover-provider.js';
import { createSignatureHelpProvider } from '#lib/kcl-language/lsp/providers/signature-provider.js';
import { createFormattingProvider } from '#lib/kcl-language/lsp/providers/formatting-provider.js';
import { createSemanticTokensProvider } from '#lib/kcl-language/lsp/providers/semantic-tokens-provider.js';
import { createFoldingRangeProvider } from '#lib/kcl-language/lsp/providers/folding-provider.js';
import { createRenameProvider } from '#lib/kcl-language/lsp/providers/rename-provider.js';
import { createDefinitionProvider } from '#lib/kcl-language/lsp/providers/definition-provider.js';
import { createCodeActionProvider } from '#lib/kcl-language/lsp/providers/code-action-provider.js';

/** Global LSP client instance */
let lspClient: KclLspClient | undefined;

/** Track if already registered to prevent duplicate registration */
let isRegistered = false;

/** Map of document URIs to their version numbers */
const documentVersions = new Map<string, number>();

/**
 * Get the LSP client instance.
 */
export function getKclLspClient(): KclLspClient | undefined {
  return lspClient;
}

/**
 * Notify the LSP server of a document open event.
 */
export function notifyDocumentOpen(uri: string, text: string): void {
  if (!lspClient?.ready) {
    return;
  }

  documentVersions.set(uri, 1);
  lspClient.textDocumentDidOpen({
    textDocument: {
      uri,
      languageId: codeLanguages.kcl,
      version: 1,
      text,
    },
  });
}

/**
 * Notify the LSP server of a document change event.
 */
export function notifyDocumentChange(uri: string, text: string): void {
  if (!lspClient?.ready) {
    return;
  }

  const version = (documentVersions.get(uri) ?? 0) + 1;
  documentVersions.set(uri, version);

  lspClient.textDocumentDidChange({
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

/**
 * Notify the LSP server of a document close event.
 */
export function notifyDocumentClose(uri: string): void {
  if (!lspClient?.ready) {
    return;
  }

  documentVersions.delete(uri);
  lspClient.textDocumentDidClose({
    textDocument: { uri },
  });
}

/**
 * Register KCL language with Monaco editor.
 *
 * This provides full language support for KCL files including:
 * - Language identification and configuration
 * - LSP-powered features: completions, hover, diagnostics, formatting, etc.
 *
 * @see https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
 */
export function registerKclLanguage(monaco: typeof Monaco): void {
  // Prevent duplicate registration
  if (isRegistered) {
    console.log('[KCL LSP] Language already registered, skipping');

    return;
  }

  isRegistered = true;

  // Register language metadata
  monaco.languages.register({
    id: codeLanguages.kcl,
    extensions: ['.kcl'],
    aliases: ['KCL', 'kcl'],
    mimetypes: ['text/x-kcl'],
  });

  // Basic language configuration
  monaco.languages.setLanguageConfiguration(codeLanguages.kcl, {
    comments: {
      lineComment: '//',
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  // Initialize LSP client and register providers
  void initializeLsp(monaco);
}

/**
 * Initialize the LSP client and register all Monaco providers.
 */
async function initializeLsp(monaco: typeof Monaco): Promise<void> {
  // Create diagnostics handler
  const diagnosticsHandler = createDiagnosticsHandler(monaco);

  // Create and initialize LSP client
  lspClient = new KclLspClient({
    onInitialized() {
      console.log('[KCL LSP] Client initialized successfully');
    },
    onNotification(notification: LSP.NotificationMessage) {
      diagnosticsHandler(notification);
    },
  });

  try {
    await lspClient.initialize();
  } catch (error) {
    console.error('[KCL LSP] Failed to initialize client:', error);
    lspClient = undefined;

    return;
  }

  // Wait for the client to be ready
  await lspClient.waitForReady();

  // Register Monaco language providers
  const languageId = codeLanguages.kcl;

  // Completion provider
  monaco.languages.registerCompletionItemProvider(languageId, createCompletionProvider(monaco, lspClient));

  // Hover provider
  monaco.languages.registerHoverProvider(languageId, createHoverProvider(monaco, lspClient));

  // Signature help provider
  monaco.languages.registerSignatureHelpProvider(languageId, createSignatureHelpProvider(monaco, lspClient));

  // Document formatting provider
  monaco.languages.registerDocumentFormattingEditProvider(languageId, createFormattingProvider(monaco, lspClient));

  // Semantic tokens provider
  monaco.languages.registerDocumentSemanticTokensProvider(languageId, createSemanticTokensProvider(monaco, lspClient));

  // Folding range provider
  monaco.languages.registerFoldingRangeProvider(languageId, createFoldingRangeProvider(monaco, lspClient));

  // Rename provider
  monaco.languages.registerRenameProvider(languageId, createRenameProvider(monaco, lspClient));

  // Definition provider
  monaco.languages.registerDefinitionProvider(languageId, createDefinitionProvider(monaco, lspClient));

  // Code action provider
  monaco.languages.registerCodeActionProvider(languageId, createCodeActionProvider(monaco, lspClient));

  // Set up document synchronization
  setupDocumentSync(monaco, lspClient);

  console.log('[KCL LSP] All Monaco providers registered');
}

/**
 * Set up document synchronization between Monaco models and the LSP server.
 * This follows the same pattern as Monaco's built-in TypeScript language service.
 */
function setupDocumentSync(monaco: typeof Monaco, client: KclLspClient): void {
  const languageId = codeLanguages.kcl;

  // Handle existing models (might be created before LSP was ready)
  for (const model of monaco.editor.getModels()) {
    if (model.getLanguageId() === languageId) {
      syncDocumentOpen(client, model);
    }
  }

  // Handle new models
  monaco.editor.onDidCreateModel((model) => {
    if (model.getLanguageId() === languageId) {
      syncDocumentOpen(client, model);
    }
  });

  // Handle model language changes (e.g., file renamed to .kcl)
  monaco.editor.onDidChangeModelLanguage((event) => {
    const newLanguage = event.model.getLanguageId();
    if (newLanguage === languageId) {
      syncDocumentOpen(client, event.model);
    } else if (event.oldLanguage === languageId) {
      syncDocumentClose(client, event.model.uri.toString());
    }
  });

  // Handle model disposal
  monaco.editor.onWillDisposeModel((model) => {
    if (model.getLanguageId() === languageId) {
      syncDocumentClose(client, model.uri.toString());
    }
  });
}

/**
 * Sync a model open event to the LSP server.
 */
function syncDocumentOpen(client: KclLspClient, model: Monaco.editor.ITextModel): void {
  const uri = model.uri.toString();
  const text = model.getValue();

  documentVersions.set(uri, 1);
  client.textDocumentDidOpen({
    textDocument: {
      uri,
      languageId: codeLanguages.kcl,
      version: 1,
      text,
    },
  });

  // Listen for content changes on this model
  model.onDidChangeContent(() => {
    const version = (documentVersions.get(uri) ?? 0) + 1;
    documentVersions.set(uri, version);

    client.textDocumentDidChange({
      textDocument: { uri, version },
      contentChanges: [{ text: model.getValue() }],
    });
  });
}

/**
 * Sync a model close event to the LSP server.
 */
function syncDocumentClose(client: KclLspClient, uri: string): void {
  documentVersions.delete(uri);
  client.textDocumentDidClose({
    textDocument: { uri },
  });
}

/**
 * Dispose of the LSP client and clean up resources.
 */
export function disposeKclLsp(): void {
  lspClient?.dispose();
  lspClient = undefined;
  documentVersions.clear();
}
