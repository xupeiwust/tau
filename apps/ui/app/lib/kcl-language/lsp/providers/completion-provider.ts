/**
 * Monaco completion provider for KCL LSP.
 */

import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { CompletionTriggerKind } from 'vscode-languageserver-protocol';
import type * as LSP from 'vscode-languageserver-protocol';
import type { KclLspClient } from '#lib/kcl-language/lsp/kcl-lsp-client.js';
import { monacoToLspPosition, lspToMonacoRange } from '#lib/kcl-language/lsp/utils/position-utils.js';
import { lspToMonacoCompletionKind, formatDocumentation } from '#lib/kcl-language/lsp/utils/lsp-kind-utils.js';

/**
 * Create a Monaco completion provider that uses the LSP client.
 */
export function createCompletionProvider(
  monaco: typeof Monaco,
  client: KclLspClient,
): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', '|'],

    async provideCompletionItems(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      context: Monaco.languages.CompletionContext,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.CompletionList | undefined> {
      console.log('[KCL Completion] provideCompletionItems called, uri:', model.uri.toString(), 'position:', position);
      console.log('[KCL Completion] client ready:', client.ready);

      const result = await client.textDocumentCompletion({
        textDocument: { uri: model.uri.toString() },
        position: monacoToLspPosition(position),
        context: {
          triggerKind:
            context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter
              ? CompletionTriggerKind.TriggerCharacter
              : CompletionTriggerKind.Invoked,
          triggerCharacter: context.triggerCharacter,
        },
      });

      console.log('[KCL Completion] result:', result);

      if (!result) {
        console.log('[KCL Completion] No result returned');
        return undefined;
      }

      const items = 'items' in result ? result.items : result;
      console.log('[KCL Completion] Returning', items.length, 'items');

      return {
        suggestions: items.map((item) => convertCompletionItem(monaco, item, model)),
      };
    },

    async resolveCompletionItem(
      item: Monaco.languages.CompletionItem,
      _token: Monaco.CancellationToken,
    ): Promise<Monaco.languages.CompletionItem> {
      // If we have original LSP item data, resolve it
      const lspItem = (item as Monaco.languages.CompletionItem & { data?: LSP.CompletionItem }).data;
      if (lspItem) {
        const resolved = await client.completionItemResolve(lspItem);
        if (resolved.documentation) {
          item.documentation = formatDocumentation(resolved.documentation);
        }
      }

      return item;
    },
  };
}

/**
 * Convert LSP CompletionItem to Monaco CompletionItem.
 */
function convertCompletionItem(
  monaco: typeof Monaco,
  item: LSP.CompletionItem,
  model: Monaco.editor.ITextModel,
): Monaco.languages.CompletionItem {
  const insertText = item.insertText ?? item.label;

  let range: Monaco.IRange | undefined;
  if (item.textEdit && 'range' in item.textEdit) {
    range = lspToMonacoRange(monaco, item.textEdit.range);
  }

  // Use model's full range if no range specified
  const defaultRange = range ?? model.getFullModelRange();

  return {
    label: item.label,
    kind: lspToMonacoCompletionKind(monaco, item.kind),
    detail: item.detail,
    documentation: formatDocumentation(item.documentation),
    insertText,
    insertTextRules:
      item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: defaultRange,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
  };
}
