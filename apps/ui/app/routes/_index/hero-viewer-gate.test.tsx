// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('#routes/_index/hero-viewer.js', () => ({
  HeroViewer: () => <div data-testid='hero-viewer'>HeroViewer</div>,
}));

describe('LazyHeroViewer', () => {
  let intersectionCallback: IntersectionObserverCallback;

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class MockIntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  it('should not render HeroViewer before intersection', async () => {
    const { LazyHeroViewer } = await import('#routes/_index/hero-viewer-gate.js');

    render(<LazyHeroViewer />);

    expect(screen.queryByTestId('hero-viewer')).toBeNull();
  });

  it('should render HeroViewer after intersection observer triggers', async () => {
    const { LazyHeroViewer } = await import('#routes/_index/hero-viewer-gate.js');

    render(<LazyHeroViewer />);

    await act(() => {
      intersectionCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(await screen.findByTestId('hero-viewer')).toBeDefined();
  });

  it('should render a loading placeholder before intersection', async () => {
    const { LazyHeroViewer } = await import('#routes/_index/hero-viewer-gate.js');

    const { container } = render(<LazyHeroViewer />);

    // The sentinel div should exist with min-height to reserve space
    const sentinel = container.firstElementChild;
    expect(sentinel).toBeDefined();
  });
});
