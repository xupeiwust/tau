// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { tauEditorPanelDragMime, tauFileDragMime, tauViewerPanelDragMime } from '@taucad/types/constants';
import type { ResolvedModel } from '#hooks/use-models.js';

const stableModel: ResolvedModel = {
  id: 'chat-scoped-model',
  details: { family: 'gpt' },
} as unknown as ResolvedModel;

let mockActiveModel: ResolvedModel = stableModel;
const mockSetActiveModel = vi.fn();

vi.mock('#hooks/use-active-chat-model.js', () => ({
  useActiveChatModel: () => ({
    modelId: mockActiveModel.id,
    model: mockActiveModel,
    setActiveModel: mockSetActiveModel,
  }),
}));

const mockUseChatSelector = vi.fn((selector: (state: unknown) => unknown) =>
  selector({
    status: 'idle',
    draftText: 'hello world',
    draftImages: [] as string[],
    draftToolChoice: 'auto',
    draftMode: 'agent',
    editDraftText: '',
    editDraftImages: [] as string[],
  }),
);

vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({
    stop: vi.fn(),
    setDraftText: vi.fn(),
    addDraftImage: vi.fn(),
    removeDraftImage: vi.fn(),
    setDraftToolChoice: vi.fn(),
    setEditDraftText: vi.fn(),
    addEditDraftImage: vi.fn(),
    removeEditDraftImage: vi.fn(),
  }),
  useChatSelector: (selector: (state: unknown) => unknown) => mockUseChatSelector(selector),
}));

vi.mock('#hooks/use-keyboard.js', () => ({
  useKeybinding: () => ({ formattedKeyCombination: 'Ctrl+Backspace' }),
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: { error: vi.fn() },
}));

const { useChatTextareaLogic } = await import('#components/chat/chat-textarea-types.js');

describe('useChatTextareaLogic — chat-scoped model wiring (E1, R6/R11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveModel = stableModel;
  });

  it('should expose the chat-scoped model on selectedModel', () => {
    const { result } = renderHook(() =>
      useChatTextareaLogic({
        ref: undefined,
        onSubmit: vi.fn(async () => undefined),
      }),
    );

    expect(result.current.selectedModel.id).toBe('chat-scoped-model');
  });

  it('should stamp the chat-scoped model id onto onSubmit when handleSubmit fires', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useChatTextareaLogic({ ref: undefined, onSubmit }));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello world',
        model: 'chat-scoped-model',
      }),
    );
  });

  it('should follow the chat-scoped model when it changes between submits (no cookie bleed)', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(() => useChatTextareaLogic({ ref: undefined, onSubmit }));

    await act(async () => {
      await result.current.handleSubmit();
    });

    mockActiveModel = { id: 'next-chat-scoped-model', details: { family: 'gpt' } } as unknown as ResolvedModel;
    rerender();

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSubmit).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'next-chat-scoped-model' }));
  });
});

/**
 * Drag-detection + drop-routing contract for the outer container handler.
 *
 * `handleDragOver` derives `dragKind` from `event.dataTransfer.types`, and
 * `handleDrop` dispatches by MIME — viewer→onViewerScreenshotDrop,
 * editor/file→onAddContextChips, otherwise the existing image-file path.
 */
describe('useChatTextareaLogic — dragKind detection + drop routing', () => {
  type DragInit = {
    readonly types: readonly string[];
    readonly data?: Readonly<Record<string, string>>;
    readonly files?: readonly File[];
  };

  const buildDragEvent = (init: DragInit): React.DragEvent => {
    const data = init.data ?? {};
    const dataTransfer = {
      types: init.types,
      files: init.files ?? [],
      getData: (mime: string): string => data[mime] ?? '',
    } as unknown as DataTransfer;
    return {
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as React.DragEvent;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveModel = stableModel;
  });

  it('sets dragKind to "viewer" when the viewer panel mime is present', () => {
    const { result } = renderHook(() =>
      useChatTextareaLogic({ ref: undefined, onSubmit: vi.fn(async () => undefined) }),
    );

    act(() => {
      result.current.handleDragOver(buildDragEvent({ types: [tauViewerPanelDragMime] }));
    });

    expect(result.current.dragKind).toBe('viewer');
    expect(result.current.isDragging).toBe(true);
  });

  it.each([
    ['editor panel', tauEditorPanelDragMime],
    ['file tree', tauFileDragMime],
  ])('sets dragKind to "reference" when the %s mime is present', (_label, mime) => {
    const { result } = renderHook(() =>
      useChatTextareaLogic({ ref: undefined, onSubmit: vi.fn(async () => undefined) }),
    );

    act(() => {
      result.current.handleDragOver(buildDragEvent({ types: [mime] }));
    });

    expect(result.current.dragKind).toBe('reference');
  });

  it('falls back to "image" for unknown / OS file drags', () => {
    const { result } = renderHook(() =>
      useChatTextareaLogic({ ref: undefined, onSubmit: vi.fn(async () => undefined) }),
    );

    act(() => {
      result.current.handleDragOver(buildDragEvent({ types: ['Files', 'application/x-moz-file'] }));
    });

    expect(result.current.dragKind).toBe('image');
  });

  it('clears dragKind on drag leave', () => {
    const { result } = renderHook(() =>
      useChatTextareaLogic({ ref: undefined, onSubmit: vi.fn(async () => undefined) }),
    );

    act(() => {
      result.current.handleDragOver(buildDragEvent({ types: [tauViewerPanelDragMime] }));
    });
    expect(result.current.dragKind).toBe('viewer');

    act(() => {
      result.current.handleDragLeave();
    });
    expect(result.current.dragKind).toBeUndefined();
  });

  it('routes a viewer drop to onViewerScreenshotDrop with the entryFile', () => {
    const onViewerScreenshotDrop = vi.fn();
    const onAddContextChips = vi.fn();
    const { result } = renderHook(() =>
      useChatTextareaLogic({
        ref: undefined,
        onSubmit: vi.fn(async () => undefined),
        onViewerScreenshotDrop,
        onAddContextChips,
      }),
    );

    act(() => {
      result.current.handleDrop(
        buildDragEvent({
          types: [tauViewerPanelDragMime],
          data: { [tauViewerPanelDragMime]: JSON.stringify({ entryFile: 'models/part.scad' }) },
        }),
      );
    });

    expect(onViewerScreenshotDrop).toHaveBeenCalledExactlyOnceWith('models/part.scad');
    expect(onAddContextChips).not.toHaveBeenCalled();
  });

  it('routes an editor panel drop to onAddContextChips with one path', () => {
    const onViewerScreenshotDrop = vi.fn();
    const onAddContextChips = vi.fn();
    const { result } = renderHook(() =>
      useChatTextareaLogic({
        ref: undefined,
        onSubmit: vi.fn(async () => undefined),
        onViewerScreenshotDrop,
        onAddContextChips,
      }),
    );

    act(() => {
      result.current.handleDrop(
        buildDragEvent({
          types: [tauEditorPanelDragMime],
          data: { [tauEditorPanelDragMime]: JSON.stringify({ filePath: 'lib/head.scad' }) },
        }),
      );
    });

    expect(onAddContextChips).toHaveBeenCalledExactlyOnceWith(['lib/head.scad']);
    expect(onViewerScreenshotDrop).not.toHaveBeenCalled();
  });

  it('routes a file-tree drop (JSON array payload) to onAddContextChips', () => {
    const onAddContextChips = vi.fn();
    const { result } = renderHook(() =>
      useChatTextareaLogic({
        ref: undefined,
        onSubmit: vi.fn(async () => undefined),
        onAddContextChips,
      }),
    );

    act(() => {
      result.current.handleDrop(
        buildDragEvent({
          types: [tauFileDragMime],
          data: { [tauFileDragMime]: JSON.stringify(['a/one.ts', 'b/two.ts']) },
        }),
      );
    });

    expect(onAddContextChips).toHaveBeenCalledExactlyOnceWith(['a/one.ts', 'b/two.ts']);
  });

  it('does not call any drop callback when only OS files are present (image branch handles them)', () => {
    const onViewerScreenshotDrop = vi.fn();
    const onAddContextChips = vi.fn();
    const { result } = renderHook(() =>
      useChatTextareaLogic({
        ref: undefined,
        onSubmit: vi.fn(async () => undefined),
        onViewerScreenshotDrop,
        onAddContextChips,
      }),
    );

    act(() => {
      result.current.handleDrop(buildDragEvent({ types: ['Files'], files: [] }));
    });

    expect(onViewerScreenshotDrop).not.toHaveBeenCalled();
    expect(onAddContextChips).not.toHaveBeenCalled();
  });
});
