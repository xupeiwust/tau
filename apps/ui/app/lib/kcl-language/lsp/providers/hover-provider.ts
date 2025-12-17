/**
 * Monaco hover provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';
import { formatDocumentation } from '#lib/kcl-language/lsp/utils/lsp-kind-utils.js';

/**
 * Create a Monaco hover provider that uses the LSP client.
 */
export function createHoverProvider(monaco: typeof Monaco, client: KclLspClient): Monaco.languages.HoverProvider {
  return {
    async provideHover(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.Hover | undefined> {
      const result = await client.textDocumentHover({
        textDocument: { uri: model.uri.toString() },
        position: monacoToLspPosition(position),
      });

      if (!result) {
        return undefined;
      }

      const contents = convertHoverContents(result.contents);

      return {
        contents,
        range: result.range ? lspToMonacoRange(monaco, result.range) : undefined,
      };
    },
  };
}

/**
 * Convert LSP hover contents to Monaco markdown strings.
 */
function convertHoverContents(
  contents:
    | string
    | { language: string; value: string }
    | { kind: string; value: string }
    | Array<string | { language: string; value: string }>,
): Monaco.IMarkdownString[] {
  if (typeof contents === 'string') {
    return [{ value: contents }];
  }

  if (Array.isArray(contents)) {
    return contents.map((content) => {
      if (typeof content === 'string') {
        return { value: content };
      }

      return { value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` };
    });
  }

  // MarkedString with language
  if ('language' in contents) {
    return [{ value: `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` }];
  }

  // MarkupContent
  if ('kind' in contents) {
    const formatted = formatDocumentation(contents as { kind: 'markdown' | 'plaintext'; value: string });

    return formatted ? [typeof formatted === 'string' ? { value: formatted } : formatted] : [];
  }

  return [];
}
