import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// oxlint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest `importOriginal` generic requires a value namespace import
import * as XStateReactNamespace from '@xstate/react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { FileSystemBackend } from '@taucad/types';

const indexedDb: FileSystemBackend = 'indexeddb';

type FileWrittenEvent = { type: 'fileWritten'; path: string; backend: FileSystemBackend };
type FileDeletedEvent = { type: 'fileDeleted'; path: string; backend: FileSystemBackend };
type DirectoryChangedEvent = { type: 'directoryChanged'; path: string; backend: FileSystemBackend };
type FileRenamedEvent = {
  type: 'fileRenamed';
  oldPath: string | undefined;
  newPath: string | undefined;
  backend: FileSystemBackend;
};

type FakeChannel = {
  readonly label: string;
  readonly subscriptionOffs: Array<Mock<() => void>>;
  onFileWritten(sub: { handler: (event: FileWrittenEvent) => void }): () => void;
  onFileDeleted(sub: { handler: (event: FileDeletedEvent) => void }): () => void;
  onFileRenamed(sub: { handler: (event: FileRenamedEvent) => void }): () => void;
  onDirectoryChanged(sub: { handler: (event: DirectoryChangedEvent) => void }): () => void;
  emitFileWritten(path: string, backend?: FileSystemBackend): void;
  emitFileDeleted(path: string, backend?: FileSystemBackend): void;
  emitFileRenamed(event: Omit<FileRenamedEvent, 'type'>): void;
  emitDirectoryChanged(path: string, backend?: FileSystemBackend): void;
};

const testState = vi.hoisted(() => {
  const mockTouchProject = vi.fn<(projectId: string) => Promise<undefined>>();

  function createFakeChannel(label: string): FakeChannel {
    let onFileWrittenHandler: ((event: FileWrittenEvent) => void) | undefined;
    let onFileDeletedHandler: ((event: FileDeletedEvent) => void) | undefined;
    let onFileRenamedHandler: ((event: FileRenamedEvent) => void) | undefined;
    let onDirectoryChangedHandler: ((event: DirectoryChangedEvent) => void) | undefined;
    const subscriptionOffs: Array<Mock<() => void>> = [];

    const reg = (off: Mock<() => void>): (() => void) => {
      subscriptionOffs.push(off);
      return off;
    };

    return {
      label,
      subscriptionOffs,
      onFileWritten(sub: { handler: (event: FileWrittenEvent) => void }) {
        onFileWrittenHandler = sub.handler;
        return reg(vi.fn<() => void>());
      },
      onFileDeleted(sub: { handler: (event: FileDeletedEvent) => void }) {
        onFileDeletedHandler = sub.handler;
        return reg(vi.fn<() => void>());
      },
      onFileRenamed(sub: { handler: (event: FileRenamedEvent) => void }) {
        onFileRenamedHandler = sub.handler;
        return reg(vi.fn<() => void>());
      },
      onDirectoryChanged(sub: { handler: (event: DirectoryChangedEvent) => void }) {
        onDirectoryChangedHandler = sub.handler;
        return reg(vi.fn<() => void>());
      },
      emitFileWritten(path: string, backend: FileSystemBackend = indexedDb) {
        onFileWrittenHandler?.({ type: 'fileWritten', path, backend });
      },
      emitFileDeleted(path: string, backend: FileSystemBackend = indexedDb) {
        onFileDeletedHandler?.({ type: 'fileDeleted', path, backend });
      },
      emitFileRenamed(event: Omit<FileRenamedEvent, 'type'>) {
        onFileRenamedHandler?.({ type: 'fileRenamed', ...event });
      },
      emitDirectoryChanged(path: string, backend: FileSystemBackend = indexedDb) {
        onDirectoryChangedHandler?.({ type: 'directoryChanged', path, backend });
      },
    };
  }

  let channel: FakeChannel = createFakeChannel('default');

  return {
    mockTouchProject,
    createFakeChannel,
    getChannel(): FakeChannel {
      return channel;
    },
    setChannel(next: FakeChannel): void {
      channel = next;
    },
    resetChannel(): void {
      channel = createFakeChannel('default');
    },
  };
});

vi.mock('#hooks/use-project-manager.js', () => ({
  useProjectManager: () => ({
    touchProject: testState.mockTouchProject,
  }),
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({
    fileManagerRef: {},
  }),
}));

vi.mock('@xstate/react', async (importOriginal) => {
  const actual = await importOriginal<typeof XStateReactNamespace>();
  return {
    ...actual,
    useSelector: vi.fn(
      (
        _actorRef: unknown,
        selector: (snapshot: { context: { workerChangeChannel: FakeChannel | undefined } }) => unknown,
      ) => {
        return selector({
          context: { workerChangeChannel: testState.getChannel() as FakeChannel | undefined },
        });
      },
    ),
  };
});

const { ProjectActivityTracker, parseProjectIdFromPath, isUserInitiatedProjectPath } =
  await import('#hooks/project-activity-tracker.js');

function renderTracker(): ReturnType<typeof render> & {
  queryClient: QueryClient;
  rerenderTracker: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const result = render(<ProjectActivityTracker />, { wrapper });
  return {
    ...result,
    queryClient,
    rerenderTracker: () => {
      result.rerender(
        <QueryClientProvider client={queryClient}>
          <ProjectActivityTracker />
        </QueryClientProvider>,
      );
    },
  };
}

describe('ProjectActivityTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.resetChannel();
    testState.mockTouchProject.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('should debounce touchProject and invalidate projects query after trailing window', async () => {
    const { queryClient } = renderTracker();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('projects/p1/main.scad');

    expect(testState.mockTouchProject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledTimes(1);
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('should collapse bursty writes into one touchProject', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('projects/p1/a.scad');
    await vi.advanceTimersByTimeAsync(500);
    testState.getChannel().emitFileWritten('projects/p1/b.scad');
    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledTimes(1);
  });

  it('should ignore .tau paths under a project', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('projects/p1/.tau/cache/x');
    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should ignore node_modules under a project', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('projects/p1/node_modules/y/z.js');
    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should ignore paths outside projects/', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('something-else/file.txt');
    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should schedule bump when fileRenamed touches a project path', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileRenamed({
      oldPath: 'projects/p9/old.scad',
      newPath: 'tmp/outside',
      backend: indexedDb,
    });
    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p9');
  });

  it('should not call touchProject after unmount when debounce has not fired', async () => {
    const { unmount } = renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('projects/p1/x.ts');
    unmount();

    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should bump on fileDeleted under a project', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileDeleted('projects/p1/x.ts');
    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p1');
  });

  it('should bump on directoryChanged under a project', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitDirectoryChanged('projects/p1/sub');
    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p1');
  });

  it('should ignore directoryChanged at workspace root', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitDirectoryChanged('');
    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should bump only the defined edge when fileRenamed has one undefined side', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileRenamed({
      oldPath: undefined,
      newPath: 'projects/p1/new.ts',
      backend: indexedDb,
    });
    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p1');
  });

  it('should not bump when fileRenamed has both edges undefined', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileRenamed({
      oldPath: undefined,
      newPath: undefined,
      backend: indexedDb,
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should bump separately when fileRenamed crosses two projects', async () => {
    renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileRenamed({
      oldPath: 'projects/p1/a.ts',
      newPath: 'projects/p2/a.ts',
      backend: indexedDb,
    });
    await vi.advanceTimersByTimeAsync(2000);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testState.mockTouchProject).toHaveBeenCalledTimes(2);
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p1');
    expect(testState.mockTouchProject).toHaveBeenCalledWith('p2');
  });

  it('should unsubscribe all four handlers on unmount', async () => {
    const { unmount } = renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    const offs = testState.getChannel().subscriptionOffs;
    unmount();

    for (const off of offs) {
      expect(off).toHaveBeenCalledTimes(1);
    }
  });

  it('should clear pending timers on unmount', async () => {
    const { unmount } = renderTracker();

    await waitFor(() => {
      expect(testState.getChannel().subscriptionOffs.length).toBe(4);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    testState.getChannel().emitFileWritten('projects/p1/x.ts');
    unmount();

    await vi.advanceTimersByTimeAsync(2000);

    expect(testState.mockTouchProject).not.toHaveBeenCalled();
  });

  it('should re-subscribe when channel identity changes', async () => {
    const channelA = testState.createFakeChannel('a');
    testState.setChannel(channelA);
    const { rerenderTracker } = renderTracker();

    await waitFor(() => {
      expect(channelA.subscriptionOffs.length).toBe(4);
    });

    const channelB = testState.createFakeChannel('b');
    testState.setChannel(channelB);
    rerenderTracker();

    await waitFor(() => {
      expect(channelB.subscriptionOffs.length).toBe(4);
    });

    for (const off of channelA.subscriptionOffs) {
      expect(off).toHaveBeenCalledTimes(1);
    }
  });
});

describe('parseProjectIdFromPath (project activity)', () => {
  it('should parse project id and rest from workspace-relative path', () => {
    expect(parseProjectIdFromPath('projects/abc/foo/bar')).toEqual({
      projectId: 'abc',
      rest: 'foo/bar',
    });
  });

  it('should accept top-level dotfiles as user-initiated', () => {
    expect(isUserInitiatedProjectPath('.gitignore')).toBe(true);
  });
});
