import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { fromPromise, waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Remote } from 'comlink';
import { useQueryClient } from '@tanstack/react-query';
import { useFileManager } from '#hooks/use-file-manager.js';
import type { ObjectStoreWorker } from '#hooks/object-store.worker.js';
import { buildMachine } from '#machines/build.machine.js';
import type { gitMachine } from '#machines/git.machine.js';
import { editorMachine } from '#machines/editor.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { screenshotCapabilityMachine } from '#machines/screenshot-capability.machine.js';
import type { cameraCapabilityMachine } from '#machines/camera-capability.machine.js';
import type { logMachine } from '#machines/logs.machine.js';
import { inspect } from '#machines/inspector.js';
import { useBuildManager } from '#hooks/use-build-manager.js';

type BuildContextType = {
  buildId: string;
  buildRef: ActorRefFrom<typeof buildMachine>;
  editorRef: ActorRefFrom<typeof editorMachine>;
  gitRef: ActorRefFrom<typeof gitMachine>;
  graphicsRef: ActorRefFrom<typeof graphicsMachine>;
  cadRef: ActorRefFrom<typeof cadMachine>;
  screenshotRef: ActorRefFrom<typeof screenshotCapabilityMachine>;
  cameraRef: ActorRefFrom<typeof cameraCapabilityMachine>;
  logRef: ActorRefFrom<typeof logMachine>;
  setCodeParameters: (
    files: Record<string, { content: Uint8Array<ArrayBuffer> }>,
    parameters: Record<string, unknown>,
  ) => void;
  setParameters: (parameters: Record<string, unknown>) => void;
  updateName: (name: string) => void;
  updateDescription: (description: string) => void;
  updateTags: (tags: string[]) => void;
  updateThumbnail: (thumbnail: string) => void;
  getMainFilename: () => Promise<string>;
  setLastChatId: (chatId: string) => void;
};

const BuildContext = createContext<BuildContextType | undefined>(undefined);

export function BuildProvider({
  children,
  buildId,
  provide,
  input,
}: {
  readonly children: ReactNode;
  readonly buildId: string;
  readonly provide?: Parameters<typeof buildMachine.provide>[0];
  readonly input?: Omit<Parameters<typeof useActorRef<typeof buildMachine>>[1]['input'], 'buildId' | 'fileManagerRef'>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // Create the build machine actor - it will auto-load based on buildId
  const fileManager = useFileManager();
  const buildManager = useBuildManager();

  const actorRef = useActorRef(
    buildMachine.provide({
      actors: {
        loadBuildActor: fromPromise(async ({ input }) => {
          const build = await buildManager.getBuild(input.buildId);
          if (!build) {
            throw new Error(`Build not found: ${input.buildId}`);
          }

          // Ensure the file manager is ready before loading the build
          await waitFor(fileManager.fileManagerRef, (state) => state.matches('ready'));

          return build;
        }),
        writeBuildActor: fromPromise(async ({ input }) => {
          await buildManager.updateBuild(input.build.id, input.build);
        }),
      },
      ...provide,
    }),
    {
      input: { buildId, fileManagerRef: fileManager.fileManagerRef, ...input },
      inspect,
    },
  );

  // Get the worker for Editor state persistence
  const getReadiedWorker = useCallback(async (): Promise<Remote<ObjectStoreWorker>> => {
    const snapshot = await waitFor(
      buildManager.buildManagerRef,
      (state) => state.matches('ready') || state.matches('error'),
    );
    if (snapshot.matches('error')) {
      throw new Error('Build manager worker failed to initialize');
    }

    if (!snapshot.context.wrappedWorker) {
      throw new Error('Build manager worker not initialized');
    }

    return snapshot.context.wrappedWorker;
  }, [buildManager.buildManagerRef]);

  // Create Editor state machine with provided actors
  const editorRef = useActorRef(
    editorMachine.provide({
      actors: {
        loadEditorStateActor: fromPromise(async ({ input }) => {
          const worker = await getReadiedWorker();
          return worker.getEditorState(input.buildId);
        }),
        saveEditorStateActor: fromPromise(async ({ input }) => {
          const worker = await getReadiedWorker();
          await worker.updateEditorState(input.editorState);
        }),
      },
    }),
    {
      input: { buildId },
      inspect,
    },
  );

  // Select state from the machine
  const gitRef = useSelector(actorRef, (state) => state.context.gitRef);
  const graphicsRef = useSelector(actorRef, (state) => state.context.graphicsRef);
  const cadRef = useSelector(actorRef, (state) => state.context.cadRef);
  const screenshotRef = useSelector(actorRef, (state) => state.context.screenshotRef);
  const cameraRef = useSelector(actorRef, (state) => state.context.cameraRef);
  const logRef = useSelector(actorRef, (state) => state.context.logRef);

  useEffect(() => {
    // FileManager → CAD coordination
    const fileWrittenSub = fileManager.fileManagerRef.on('fileWritten', (event) => {
      // For machine sources (LLM/chat tools streaming to multiple files),
      // always render the active file to avoid switching context, but ensure
      // downstream file changes are incorporated into the active file's render
      const isMachine = event.source === 'machine';
      const { activeFilePath } = editorRef.getSnapshot().context;

      if (isMachine) {
        // Machine writes: always re-render the active file to pick up any
        // downstream changes (e.g., imported files that were modified)
        if (activeFilePath) {
          cadRef.send({
            type: 'setFile',
            file: { path: `/builds/${buildId}`, filename: activeFilePath },
          });
        }
      } else {
        // Non-machine writes: render the written file directly
        cadRef.send({
          type: 'setFile',
          file: { path: `/builds/${buildId}`, filename: event.path },
        });
      }
    });

    return () => {
      fileWrittenSub.unsubscribe();
    };
  }, [fileManager.fileManagerRef, cadRef, buildId, editorRef]);

  useEffect(() => {
    // Load the new build when the buildId changes
    actorRef.send({ type: 'loadBuild', buildId });

    // Reload Editor state for new build (also clears open files via closeAll in updateBuildId)
    editorRef.send({ type: 'reload', buildId });
  }, [actorRef, buildId, editorRef]);

  // Coordinate: load Editor state after build loads
  useEffect(() => {
    const buildLoadedSub = actorRef.on('buildLoaded', () => {
      // Build loaded, now load Editor state
      editorRef.send({ type: 'load' });
    });

    return () => {
      buildLoadedSub.unsubscribe();
    };
  }, [actorRef, editorRef]);

  useEffect(() => {
    const subscription = actorRef.on('buildUpdated', () => {
      // The build updated, invalidate the builds query
      void queryClient.invalidateQueries({ queryKey: ['builds'] });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [actorRef, queryClient]);

  // Memoize callbacks
  const setCodeParameters = useCallback(
    (files: Record<string, { content: Uint8Array<ArrayBuffer> }>, parameters: Record<string, unknown>) => {
      actorRef.send({ type: 'updateCodeParameters', files, parameters });
    },
    [actorRef],
  );

  const setParameters = useCallback(
    (parameters: Record<string, unknown>) => {
      actorRef.send({ type: 'setParameters', parameters });
    },
    [actorRef],
  );

  const updateName = useCallback(
    (name: string) => {
      actorRef.send({ type: 'updateName', name });
    },
    [actorRef],
  );

  const updateDescription = useCallback(
    (description: string) => {
      actorRef.send({ type: 'updateDescription', description });
    },
    [actorRef],
  );

  const updateTags = useCallback(
    (tags: string[]) => {
      actorRef.send({ type: 'updateTags', tags });
    },
    [actorRef],
  );

  const updateThumbnail = useCallback(
    (thumbnail: string) => {
      actorRef.send({ type: 'updateThumbnail', thumbnail });
    },
    [actorRef],
  );

  const setLastChatId = useCallback(
    (chatId: string) => {
      editorRef.send({ type: 'setLastChatId', chatId });
    },
    [editorRef],
  );

  const getMainFilename = useCallback(async () => {
    const snapshot = await waitFor(actorRef, (state) => Boolean(state.context.build?.assets.mechanical?.main));

    if (!snapshot.context.build?.assets.mechanical?.main) {
      throw new Error('Main file not found');
    }

    return snapshot.context.build.assets.mechanical.main;
  }, [actorRef]);

  const value = useMemo<BuildContextType>(() => {
    return {
      buildId,
      buildRef: actorRef,
      editorRef,
      gitRef,
      graphicsRef,
      cadRef,
      screenshotRef,
      cameraRef,
      logRef,
      setCodeParameters,
      setParameters,
      updateName,
      updateDescription,
      updateTags,
      updateThumbnail,
      setLastChatId,
      getMainFilename,
    };
  }, [
    buildId,
    actorRef,
    editorRef,
    gitRef,
    graphicsRef,
    cadRef,
    screenshotRef,
    cameraRef,
    logRef,
    setCodeParameters,
    setParameters,
    updateName,
    updateDescription,
    updateTags,
    updateThumbnail,
    setLastChatId,
    getMainFilename,
  ]);

  return <BuildContext.Provider value={value}>{children}</BuildContext.Provider>;
}

export function useBuild<T extends BuildContextType = BuildContextType>(options?: {
  readonly enableNoContext?: false;
}): T;
export function useBuild<T extends BuildContextType = BuildContextType>(options: {
  readonly enableNoContext: true;
}): T | undefined;
export function useBuild({ enableNoContext = false }: { readonly enableNoContext?: boolean } = {}):
  | BuildContextType
  | undefined {
  const context = useContext(BuildContext);
  if (context === undefined && !enableNoContext) {
    throw new Error('useBuild must be used within a BuildProvider');
  }

  return context;
}
