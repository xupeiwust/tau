import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Remote } from 'comlink';
import { useQueryClient } from '@tanstack/react-query';
import type { RuntimeClientOptions } from '@taucad/runtime';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import type { ObjectStoreWorker } from '#hooks/object-store.worker.js';
import { projectMachine } from '#machines/project.machine.js';
import type { gitMachine } from '#machines/git.machine.js';
import { editorMachine } from '#machines/editor.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { logMachine } from '#machines/logs.machine.js';
import { inspect } from '#machines/inspector.js';
import { useProjectManager } from '#hooks/use-project-manager.js';
import { defaultKernelOptions } from '#constants/kernel-worker.constants.js';

type ProjectContextType = {
  projectId: string;
  projectRef: ActorRefFrom<typeof projectMachine>;
  editorRef: ActorRefFrom<typeof editorMachine>;
  gitRef: ActorRefFrom<typeof gitMachine>;
  /** Per-viewer-panel graphics machines, keyed by Dockview panel ID */
  viewGraphics: Map<string, ActorRefFrom<typeof graphicsMachine>>;
  /** Dynamic compilation units keyed by entry file path. Each is a headless CadMachine+KernelMachine. */
  compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>;
  /** The main entry file path from project.assets.mechanical.main. */
  mainEntryFile: string;
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

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export function ProjectProvider({
  children,
  projectId,
  provide,
  input,
  kernelOptions,
}: {
  readonly children: ReactNode;
  readonly projectId: string;
  readonly provide?: Parameters<typeof projectMachine.provide>[0];
  readonly input?: Omit<
    Parameters<typeof useActorRef<typeof projectMachine>>[1]['input'],
    'projectId' | 'fileManagerRef' | 'kernelOptions'
  >;
  readonly kernelOptions?: RuntimeClientOptions;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // Create the project machine actor - it will auto-load based on projectId
  const fileManager = useFileManager();
  const projectManager = useProjectManager();

  const actorRef = useActorRef(
    projectMachine.provide({
      actors: {
        loadProjectActor: fromSafeAsync(async ({ input }) => {
          const project = await projectManager.getProject(input.projectId);
          if (!project) {
            throw new Error(`Project not found: ${input.projectId}`);
          }

          // Ensure the file manager is ready before loading the project
          await waitFor(fileManager.fileManagerRef, (state) => state.matches('ready'));

          return { type: 'projectRetrieved', project };
        }),
        writeProjectActor: fromSafeAsync(async ({ input }) => {
          await projectManager.updateProject(input.project.id, input.project);
        }),
      },
      ...provide,
    }),
    {
      input: {
        projectId,
        fileManagerRef: fileManager.fileManagerRef,
        kernelOptions: kernelOptions ?? defaultKernelOptions,
        ...input,
      },
      inspect,
    },
  );

  // Get the worker for Editor state persistence
  const getReadiedWorker = useCallback(async (): Promise<Remote<ObjectStoreWorker>> => {
    const snapshot = await waitFor(
      projectManager.projectManagerRef,
      (state) => state.matches('ready') || state.matches('error'),
    );
    if (snapshot.matches('error')) {
      throw new Error('Project manager worker failed to initialize');
    }

    if (!snapshot.context.wrappedWorker) {
      throw new Error('Project manager worker not initialized');
    }

    return snapshot.context.wrappedWorker;
  }, [projectManager.projectManagerRef]);

  // Create Editor state machine with provided actors
  const editorRef = useActorRef(
    editorMachine.provide({
      actors: {
        loadEditorStateActor: fromSafeAsync(async ({ input }) => {
          const worker = await getReadiedWorker();
          const state = await worker.getEditorState(input.projectId);
          return { type: 'editorStateRetrieved', state };
        }),
        saveEditorStateActor: fromSafeAsync(async ({ input }) => {
          const worker = await getReadiedWorker();
          await worker.updateEditorState(input.editorState);
        }),
      },
    }),
    {
      input: { projectId },
      inspect,
    },
  );

  // Select state from the machine
  const gitRef = useSelector(actorRef, (state) => state.context.gitRef);
  const viewGraphics = useSelector(actorRef, (state) => state.context.viewGraphics);
  const compilationUnits = useSelector(actorRef, (state) => state.context.compilationUnits);
  const mainEntryFile = useSelector(
    actorRef,

    (state) => state.context.mainEntryFile,
  );
  const logRef = useSelector(actorRef, (state) => state.context.logRef);

  useEffect(() => {
    // Load the new project when the projectId changes
    actorRef.send({ type: 'loadProject', projectId });

    // Reload Editor state for new project (also clears open files via closeAll in updateProjectId)
    editorRef.send({ type: 'reload', projectId });
  }, [actorRef, projectId, editorRef]);

  // Coordinate: load Editor state after project loads
  useEffect(() => {
    const projectLoadedSub = actorRef.on('projectLoaded', () => {
      // Project loaded, now load Editor state
      editorRef.send({ type: 'load' });
    });

    return () => {
      projectLoadedSub.unsubscribe();
    };
  }, [actorRef, editorRef]);

  useEffect(() => {
    const subscription = actorRef.on('projectUpdated', () => {
      // The project updated, invalidate the projects query
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
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
    const snapshot = await waitFor(actorRef, (state) => Boolean(state.context.project?.assets.mechanical?.main));

    if (!snapshot.context.project?.assets.mechanical?.main) {
      throw new Error('Main file not found');
    }

    return snapshot.context.project.assets.mechanical.main;
  }, [actorRef]);

  const value = useMemo<ProjectContextType>(() => {
    return {
      projectId,
      projectRef: actorRef,
      editorRef,
      gitRef,
      viewGraphics,
      compilationUnits,
      mainEntryFile,
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
    projectId,
    actorRef,
    editorRef,
    gitRef,
    viewGraphics,
    compilationUnits,
    mainEntryFile,
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

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/**
 * Find the graphics actor for the viewer panel displaying the main entry file.
 * Falls back to the first available graphics actor from viewGraphics.
 * Returns undefined when no viewGraphics exist (e.g. before any viewer panel mounts).
 * Used by external consumers (screenshot, RPC handlers, parameters) that are NOT inside a GraphicsProvider.
 */
export function useMainGraphics(): ActorRefFrom<typeof graphicsMachine> | undefined {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useMainGraphics must be used within a ProjectProvider');
  }

  const { viewGraphics, editorRef, mainEntryFile } = context;

  const viewSettings = useSelector(editorRef, (state) => state.context.viewSettings);

  // Find a viewer panel showing mainEntryFile
  for (const [viewId, graphicsRef] of viewGraphics) {
    const settings = viewSettings[viewId];
    if (settings?.entryFile === mainEntryFile) {
      return graphicsRef;
    }
  }

  // Fallback: return the first available graphics actor from viewGraphics
  const firstViewGraphics = viewGraphics.values().next().value;
  if (firstViewGraphics) {
    return firstViewGraphics;
  }

  return undefined;
}

export function useProject<T extends ProjectContextType = ProjectContextType>(options?: {
  readonly enableNoContext?: false;
}): T;
export function useProject<T extends ProjectContextType = ProjectContextType>(options: {
  readonly enableNoContext: true;
}): T | undefined;
export function useProject({ enableNoContext = false }: { readonly enableNoContext?: boolean } = {}):
  | ProjectContextType
  | undefined {
  const context = useContext(ProjectContext);
  if (context === undefined && !enableNoContext) {
    throw new Error('useProject must be used within a ProjectProvider');
  }

  return context;
}
