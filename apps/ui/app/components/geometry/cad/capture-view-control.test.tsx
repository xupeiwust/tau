// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { CaptureViewScreenshotOptions } from '#components/chat/capture-view-screenshot.utils.js';

const mockAddDraftImage = vi.fn();
const mockTrigger = vi.fn();
const mockGraphicsRef = { send: vi.fn(), id: 'graphics-actor' };

const captureCalls: CaptureViewScreenshotOptions[] = [];
const mockCaptureViewScreenshot = vi.fn((options: CaptureViewScreenshotOptions) => {
  captureCalls.push(options);
});

vi.mock('#components/chat/capture-view-screenshot.utils.js', () => ({
  captureViewScreenshot: (options: CaptureViewScreenshotOptions) => {
    mockCaptureViewScreenshot(options);
  },
}));

vi.mock('#hooks/use-graphics.js', () => ({
  useGraphics: () => mockGraphicsRef,
}));

vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({ addDraftImage: mockAddDraftImage }),
}));

vi.mock('#hooks/use-image-quality.js', () => ({
  useImageQuality: () => ({ quality: 0.42, setQuality: vi.fn() }),
}));

vi.mock('#hooks/use-tick-animation.js', () => ({
  useTickAnimation: () => ({ ticked: false, trigger: mockTrigger }),
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Tooltip + DropdownMenuItem render their children directly so we can
// interact with the underlying button via testing-library.
vi.mock('#components/ui/tooltip.js', () => ({
  Tooltip: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('#components/ui/button.js', () => ({
  Button: ({ children, onClick }: { readonly children: React.ReactNode; readonly onClick?: () => void }) => (
    <button type='button' onClick={onClick} data-testid='capture-button'>
      {children}
    </button>
  ),
}));

vi.mock('#components/ui/dropdown-menu.js', () => ({
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    readonly children: React.ReactNode;
    readonly onSelect?: () => void;
  }) => (
    <button type='button' onClick={onSelect} data-testid='capture-overflow-button'>
      {children}
    </button>
  ),
}));

const { CaptureViewControl, CaptureViewOverflowControl } =
  await import('#components/geometry/cad/capture-view-control.js');

describe('CaptureViewControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureCalls.length = 0;
  });

  it('invokes captureViewScreenshot with the per-view graphicsRef + cookie quality on click', async () => {
    const user = userEvent.setup();
    render(<CaptureViewControl />);

    await user.click(screen.getByTestId('capture-button'));

    expect(mockCaptureViewScreenshot).toHaveBeenCalledOnce();
    const call = captureCalls[0]!;
    expect(call.graphicsRef).toBe(mockGraphicsRef);
    expect(call.quality).toBe(0.42);
    expect(call.activeActors).toBeInstanceOf(Set);
  });

  it('adds the resized data URL to the active chat draft when the helper resolves', async () => {
    const user = userEvent.setup();
    render(<CaptureViewControl />);

    await user.click(screen.getByTestId('capture-button'));

    captureCalls[0]!.onImage('data:image/webp;base64,RESIZED');

    expect(mockAddDraftImage).toHaveBeenCalledExactlyOnceWith('data:image/webp;base64,RESIZED');
    expect(mockTrigger).toHaveBeenCalledOnce();
  });

  it('overflow variant fires capture via DropdownMenuItem onSelect', async () => {
    const user = userEvent.setup();
    render(<CaptureViewOverflowControl />);

    await user.click(screen.getByTestId('capture-overflow-button'));

    expect(mockCaptureViewScreenshot).toHaveBeenCalledOnce();
    captureCalls[0]!.onImage('data:image/webp;base64,FROM_OVERFLOW');
    expect(mockAddDraftImage).toHaveBeenCalledExactlyOnceWith('data:image/webp;base64,FROM_OVERFLOW');
  });
});
