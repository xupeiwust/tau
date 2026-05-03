// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MyUIMessage } from '@taucad/chat';
import type { KernelId } from '@taucad/types/constants';

// The user-message metadata stamp inside ChatHistory.onSubmit must read the
// chat-scoped kernel from useActiveChatKernel — never the global cookie via
// useKernel — so a cookie change in another tab cannot silently retag the
// kernel for the active chat.

const activeKernelState: { current: KernelId } = { current: 'manifold' };
const useActiveChatKernelMock = vi.fn(() => ({
  kernelId: activeKernelState.current,
  kernel: { id: activeKernelState.current, name: activeKernelState.current },
  setActiveKernel: vi.fn(),
}));

vi.mock('#hooks/use-active-chat-kernel.js', () => ({
  useActiveChatKernel: () => useActiveChatKernelMock(),
}));

// `useKernel` must NOT be called from chat-history anymore — guard with a
// throwing mock so any regression is caught loudly.
vi.mock('#hooks/use-kernel.js', () => ({
  useKernel: () => {
    throw new Error('chat-history should no longer call useKernel — switch to useActiveChatKernel');
  },
}));

const sendMessage = vi.fn();
const chatStateRef: { current: { messages: readonly MyUIMessage[] } } = { current: { messages: [] } };
const setMockMessages = (messages: readonly MyUIMessage[]): void => {
  chatStateRef.current = { messages };
};
vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({ sendMessage }),
  useChatSelector: (selector: (state: unknown) => unknown) => {
    const { messages } = chatStateRef.current;
    return selector({
      messages,
      messageOrder: messages.map((m) => m.id),
    });
  },
}));

// Capture the textarea onSubmit callback so the test can invoke it
// directly without driving the full draft pipeline.
const capturedTextarea: { onSubmit?: (payload: unknown) => Promise<void> } = {};
vi.mock('#components/chat/chat-textarea.js', () => ({
  ChatTextarea: (properties: { readonly onSubmit?: (payload: unknown) => Promise<void> }): React.JSX.Element => {
    capturedTextarea.onSubmit = properties.onSubmit;
    return <div data-testid='chat-textarea' />;
  },
}));

vi.mock('#routes/projects_.$id/chat-message.js', () => ({
  ChatMessage: ({ messageId }: { readonly messageId: string }) => (
    <div data-testid='chat-message' data-message-id={messageId} />
  ),
}));

vi.mock('#routes/projects_.$id/scroll-down-button.js', () => ({
  ScrollDownButton: () => null,
}));

vi.mock('#routes/projects_.$id/chat-error.js', () => ({
  ChatError: () => <div data-testid='chat-error-adornment' />,
}));

vi.mock('#routes/projects_.$id/chat-history-selector.js', () => ({
  ChatHistorySelector: () => null,
}));

vi.mock('#routes/projects_.$id/chat-history-status.js', () => ({
  ChatHistoryStatus: () => null,
}));

vi.mock('#routes/projects_.$id/chat-history-empty.js', () => ({
  ChatHistoryEmpty: () => null,
}));

vi.mock('#components/ui/floating-panel.js', () => ({
  FloatingPanel: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelClose: () => null,
  FloatingPanelContent: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelContentHeader: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelErrorContent: () => null,
  FloatingPanelTrigger: () => null,
}));

vi.mock('#components/ui/key-shortcut.js', () => ({
  KeyShortcut: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('#hooks/use-keyboard.js', () => ({
  useKeybinding: () => ({ formattedKeyCombination: 'Ctrl+C' }),
}));

vi.mock('#hooks/use-cookie.js', () => ({
  useCookie: () => [true, vi.fn()],
}));

vi.mock('#components/chat/at-reference-context.js', () => ({
  AtReferenceProvider: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({ treeService: undefined }),
}));

vi.mock('#hooks/use-chats.js', () => ({
  useChats: () => ({ chats: [] }),
}));

vi.mock('#hooks/use-project.js', () => ({
  useProject: () => ({ projectId: 'project_test' }),
}));

// Capture the Virtuoso props so tests can both inspect counts and render
// the produced items by walking `itemContent` over `totalCount`.
const capturedVirtuoso: {
  totalCount?: number;
  itemContent?: (index: number) => React.ReactNode;
} = {};
vi.mock('react-virtuoso', () => ({
  Virtuoso: (properties: { readonly totalCount: number; readonly itemContent: (index: number) => React.ReactNode }) => {
    capturedVirtuoso.totalCount = properties.totalCount;
    capturedVirtuoso.itemContent = properties.itemContent;
    const items: React.ReactNode[] = [];
    for (let index = 0; index < properties.totalCount; index++) {
      items.push(
        <div key={index} data-testid='virtuoso-item' data-index={index}>
          {properties.itemContent(index)}
        </div>,
      );
    }
    return <div data-testid='virtuoso'>{items}</div>;
  },
}));

const { ChatHistory } = await import('#routes/projects_.$id/chat-history.js');

const submitDraft = async (model = 'cookie-model') => {
  await capturedTextarea.onSubmit?.({
    content: 'hello',
    model,
    metadata: {},
    imageUrls: [],
  });
};

const message = (id: string, role: MyUIMessage['role']): MyUIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text: id }],
});

describe('ChatHistory — chat-scoped kernel stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeKernelState.current = 'manifold';
    capturedTextarea.onSubmit = undefined;
    setMockMessages([]);
  });

  it('stamps user-message metadata.kernel from useActiveChatKernel (manifold)', async () => {
    render(<ChatHistory />);
    await submitDraft();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as { metadata: { kernel: string } };
    expect(sent.metadata.kernel).toBe('manifold');
  });

  it('reflects the chat-scoped kernel switch on subsequent submits (jscad)', async () => {
    // ChatHistory is wrapped in `memo` and takes no props, so the only way to
    // re-evaluate its hooks is to force a fresh mount via key changes — that
    // also exercises the `kernelRef` re-initialisation path.
    activeKernelState.current = 'jscad';
    render(<ChatHistory key='second-mount' />);
    await submitDraft();

    const sent = sendMessage.mock.calls[0]?.[0] as { metadata: { kernel: string } };
    expect(sent.metadata.kernel).toBe('jscad');
  });

  // Wire-format invariant. Every outgoing user message must carry BOTH
  // `metadata.model` and `metadata.kernel`, both resolved from chat-scoped
  // active values. The API (`apps/api/app/api/chat/chat.controller.ts`)
  // depends on these two fields together; if either drops or drifts to the
  // cookie source, the agent silently runs with the wrong system prompt or
  // tool surface — the regression that motivated this whole refactor.
  it('stamps BOTH metadata.model and metadata.kernel together (wire-format invariant)', async () => {
    activeKernelState.current = 'replicad';
    render(<ChatHistory />);
    await submitDraft('chat-scoped-model');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as {
      metadata: { kernel?: string; model?: string };
    };
    expect(sent.metadata.kernel).toBe('replicad');
    expect(sent.metadata.model).toBe('chat-scoped-model');
    expect(sent.metadata.model).toBeDefined();
    expect(sent.metadata.kernel).toBeDefined();
  });
});

describe('ChatHistory — turn group rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeKernelState.current = 'manifold';
    capturedTextarea.onSubmit = undefined;
    capturedVirtuoso.totalCount = undefined;
    capturedVirtuoso.itemContent = undefined;
    setMockMessages([]);
  });

  it('should render one TurnGroup per user message and apply min-h only to the last', () => {
    setMockMessages([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
      message('a3', 'assistant'),
    ]);

    render(<ChatHistory />);

    const items = screen.getAllByTestId('virtuoso-item');
    expect(items).toHaveLength(2);

    const firstGroup = items[0]!.firstElementChild as HTMLElement;
    const lastGroup = items[1]!.firstElementChild as HTMLElement;

    // First group bundles u1 + a1, no min-h.
    expect(firstGroup.className).not.toContain('min-h-(--chat-live-turn-min-h)');
    const firstGroupMessages = firstGroup.querySelectorAll<HTMLElement>('[data-testid="chat-message"]');
    expect([...firstGroupMessages].map((node) => node.dataset['messageId'])).toEqual(['u1', 'a1']);

    // Last group bundles u2 + a2 + a3, gets min-h to pin user message at top.
    expect(lastGroup.className).toContain('min-h-(--chat-live-turn-min-h)');
    const lastGroupMessages = lastGroup.querySelectorAll<HTMLElement>('[data-testid="chat-message"]');
    expect([...lastGroupMessages].map((node) => node.dataset['messageId'])).toEqual(['u2', 'a2', 'a3']);
  });

  it('should render a leading assistant message in its own group when no user message precedes it', () => {
    setMockMessages([message('a0', 'assistant')]);

    render(<ChatHistory />);

    const items = screen.getAllByTestId('virtuoso-item');
    expect(items).toHaveLength(1);

    // Lone assistant greeting still receives min-h because it is the last
    // (and only) group — keeps the empty-canvas effect consistent.
    const onlyGroup = items[0]!.firstElementChild as HTMLElement;
    expect(onlyGroup.className).toContain('min-h-(--chat-live-turn-min-h)');
    const messages = onlyGroup.querySelectorAll<HTMLElement>('[data-testid="chat-message"]');
    expect([...messages].map((node) => node.dataset['messageId'])).toEqual(['a0']);
  });

  it('renders ChatError adornment inside the last turn group only', () => {
    setMockMessages([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
    ]);

    render(<ChatHistory />);

    expect(screen.queryAllByTestId('chat-error-adornment')).toHaveLength(1);

    const items = screen.getAllByTestId('virtuoso-item');
    expect(items).toHaveLength(2);

    expect(items[0]!.querySelector('[data-testid="chat-error-adornment"]')).toBeNull();

    const lastTurnAdornment = items[1]!.querySelector('[data-testid="chat-error-adornment"]');
    expect(lastTurnAdornment).not.toBeNull();

    expect(screen.getByTestId('virtuoso').querySelectorAll('[data-testid="chat-error-adornment"]')).toHaveLength(1);
  });

  it('should pass the correct totalCount to Virtuoso (one per turn group)', () => {
    setMockMessages([
      message('a0', 'assistant'),
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
    ]);

    render(<ChatHistory />);

    expect(capturedVirtuoso.totalCount).toBe(3);
    expect(typeof capturedVirtuoso.itemContent).toBe('function');
  });
});
