import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useSelector } from '@xstate/react';
import { normalizePath } from '@taucad/utils/path';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useProjectManager } from '#hooks/use-project-manager.js';

/** Milliseconds. Trailing debounce before bumping `Project.updatedAt` from filesystem churn. */
const projectActivityDebounce = 2000;

/** After `normalizePath`, channel-relative `projects/...` becomes `/projects/...`. */
const projectsPathRegex = /^\/projects\/([^/]+)(?:\/(.*))?$/;

export type ParsedProjectPath = {
  readonly projectId: string;
  /** Path under the project root (may be empty). Not normalized. */
  readonly rest: string;
};

/**
 * Parses `projects/<id>/...` from a workspace-relative path (as emitted by
 * `WorkerChangeChannel` when the file manager root is `/`).
 */
export function parseProjectIdFromPath(workspaceRelativePath: string): ParsedProjectPath | undefined {
  const normalized = normalizePath(workspaceRelativePath);
  const match = projectsPathRegex.exec(normalized);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const projectId = match[1];
  const rest = match[2] ?? '';
  return { projectId, rest };
}

export function isUserInitiatedProjectPath(rest: string): boolean {
  if (rest === '' || rest === '/') {
    return true;
  }

  const firstSegment = rest.split('/').find((segment) => segment.length > 0);
  if (firstSegment === undefined) {
    return true;
  }

  if (firstSegment === '.tau' || firstSegment === '.cache' || firstSegment === 'node_modules') {
    return false;
  }

  return true;
}

/**
 * Subscribes via `WorkerChangeChannel` and bumps parent
 * `Project.updatedAt` for user-visible paths under `projects/<id>/`.
 */
export function ProjectActivityTracker(): ReactNode {
  const { fileManagerRef } = useFileManager();
  const channel = useSelector(fileManagerRef, (state) => state.context.workerChangeChannel);
  const { touchProject } = useProjectManager();
  const queryClient = useQueryClient();

  const projectBumpTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (channel === undefined) {
      return undefined;
    }

    const scheduleBumpForRelativePath = (workspaceRelativePath: string): void => {
      const parsed = parseProjectIdFromPath(workspaceRelativePath);
      if (parsed === undefined || !isUserInitiatedProjectPath(parsed.rest)) {
        return;
      }

      const { projectId } = parsed;
      const timers = projectBumpTimersRef.current;
      const existing = timers.get(projectId);
      if (existing !== undefined) {
        clearTimeout(existing);
      }

      timers.set(
        projectId,
        setTimeout(() => {
          timers.delete(projectId);
          // async-iife: bootstrap — trailing debounce flush; must not block the timer callback stack.
          void (async (): Promise<void> => {
            await touchProject(projectId);
            await queryClient.invalidateQueries({ queryKey: ['projects'] });
          })();
        }, projectActivityDebounce),
      );
    };

    const offFileWritten = channel.onFileWritten({
      handler: ({ path }) => {
        scheduleBumpForRelativePath(path);
      },
    });
    const offFileDeleted = channel.onFileDeleted({
      handler: ({ path }) => {
        scheduleBumpForRelativePath(path);
      },
    });
    const offFileRenamed = channel.onFileRenamed({
      handler: ({ oldPath, newPath }) => {
        if (oldPath !== undefined) {
          scheduleBumpForRelativePath(oldPath);
        }
        if (newPath !== undefined) {
          scheduleBumpForRelativePath(newPath);
        }
      },
    });
    const offDirectoryChanged = channel.onDirectoryChanged({
      handler: ({ path }) => {
        scheduleBumpForRelativePath(path);
      },
    });

    return () => {
      offFileWritten();
      offFileDeleted();
      offFileRenamed();
      offDirectoryChanged();
      for (const timer of projectBumpTimersRef.current.values()) {
        clearTimeout(timer);
      }

      projectBumpTimersRef.current.clear();
    };
  }, [channel, touchProject, queryClient]);

  return null;
}
