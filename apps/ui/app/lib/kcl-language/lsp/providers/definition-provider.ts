/**
 * Monaco definition provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type * as LSP from 'vscode-languageserver-protocol';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';

/**
 * Create a Monaco definition provider that uses the LSP client.
 */
export function createDefinitionProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
): Monaco.languages.DefinitionProvider {
  return {
    async provideDefinition(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.Definition | undefined> {
      const result = await client.textDocumentDefinition({
        textDocument: { uri: model.uri.toString() },
        position: monacoToLspPosition(position),
      });

      if (!result) {
        return undefined;
      }

      return convertDefinition(monaco, result);
    },
  };
}

/**
 * Convert LSP Definition result to Monaco Definition.
 */
function convertDefinition(
  monaco: typeof Monaco,
  result: LSP.Definition | LSP.DefinitionLink[],
): Monaco.languages.Definition {
  // Handle array of locations or links
  if (Array.isArray(result)) {
    return result.map((item) => {
      // DefinitionLink
      if ('targetUri' in item) {
        return {
          uri: monaco.Uri.parse(item.targetUri),
          range: lspToMonacoRange(monaco, item.targetRange),
        };
      }

      // Location
      return {
        uri: monaco.Uri.parse(item.uri),
        range: lspToMonacoRange(monaco, item.range),
      };
    });
  }

  // Single Location
  return {
    uri: monaco.Uri.parse(result.uri),
    range: lspToMonacoRange(monaco, result.range),
  };
}
