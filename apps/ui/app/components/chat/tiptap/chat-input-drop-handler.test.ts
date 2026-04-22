import { describe, expect, it, vi } from 'vitest';
import { tauEditorPanelDragMime, tauFileDragMime, tauViewerPanelDragMime } from '@taucad/types/constants';
import { ChatInputDropHandler } from '#components/chat/tiptap/chat-input-drop-handler.js';

/**
 * The chat textarea container's React `onDrop` handler is the single source of
 * truth for the three custom drag MIME types. The Tiptap plugin must therefore:
 *
 *  - return `false` when no custom MIME is present (so ProseMirror's default
 *    text-drop behavior + the React handler both run normally), and
 *  - return `true` (and `preventDefault()`) when a custom MIME is present so
 *    ProseMirror does not eagerly insert garbage text from `dataTransfer`.
 */
describe('ChatInputDropHandler — custom-mime passthrough contract', () => {
  type ProseMirrorPlugin = {
    readonly props: {
      readonly handleDrop?: (view: unknown, event: DragEvent) => boolean | undefined;
    };
  };

  const getHandleDrop = (): ((view: unknown, event: DragEvent) => boolean | undefined) => {
    const extension = ChatInputDropHandler;
    const plugins = extension.config.addProseMirrorPlugins?.call({} as never) ?? [];
    const plugin = plugins[0] as unknown as ProseMirrorPlugin | undefined;
    if (!plugin?.props.handleDrop) {
      throw new Error('ChatInputDropHandler is missing handleDrop');
    }
    return plugin.props.handleDrop;
  };

  const buildEvent = (mimeTypes: readonly string[]): DragEvent => {
    const preventDefault = vi.fn();
    const dataTransfer = {
      types: mimeTypes,
      getData: (): string => '',
    } as unknown as DataTransfer;
    return { dataTransfer, preventDefault } as unknown as DragEvent;
  };

  it('returns false when no DataTransfer is present', () => {
    const handleDrop = getHandleDrop();
    const event = { dataTransfer: null } as unknown as DragEvent;
    expect(handleDrop({}, event)).toBe(false);
  });

  it('returns false for plain text drops (passthrough to ProseMirror default)', () => {
    const handleDrop = getHandleDrop();
    const event = buildEvent(['text/plain']);
    expect(handleDrop({}, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['viewer panel mime', tauViewerPanelDragMime],
    ['editor panel mime', tauEditorPanelDragMime],
    ['file-tree mime', tauFileDragMime],
  ])('intercepts %s and prevents default without inserting nodes', (_label, mime) => {
    const handleDrop = getHandleDrop();
    const event = buildEvent([mime]);

    const result = handleDrop({}, event);

    expect(result).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
