import { expose } from 'comlink';
import type { PartialDeep } from 'type-fest';
import type { Build } from '@taucad/types';
import type { Chat } from '@taucad/chat';
import { IndexedDbStorageProvider } from '#db/indexeddb-storage.js';
import type { EditorState, EditorStateInput } from '#types/editor.types.js';

// Create a singleton instance of the storage provider
const storage = new IndexedDbStorageProvider();

// Define the worker's API
const objectStoreWorker = {
  // ============================================================================
  // Build Methods
  // ============================================================================

  async createBuild(build: Omit<Build, 'id' | 'createdAt' | 'updatedAt'>): Promise<Build> {
    return storage.createBuild(build);
  },

  /**
   * Atomic method to create a build with its associated chat and Editor state in one call.
   * This reduces roundtrips between main thread and worker.
   */
  async createBuildWithResources(options: {
    build: Omit<Build, 'id' | 'createdAt' | 'updatedAt'>;
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'>;
  }): Promise<{ build: Build; chat: Chat }> {
    const build = await storage.createBuild(options.build);
    const chat = await storage.createChat(build.id, options.chat);
    await storage.updateEditorState({
      buildId: build.id,
      openFiles: [],
      activeFilePath: undefined,
      lastChatId: chat.id,
    });
    return { build, chat };
  },

  async duplicateBuild(buildId: string): Promise<Build> {
    const build = await storage.getBuild(buildId);
    if (!build) {
      throw new Error(`Build not found: ${buildId}`);
    }

    // Create the duplicated build (lastChatId is now in Editor state, not build)
    const newBuild = await storage.createBuild({
      ...build,
      name: `${build.name} (Copy)`,
    });

    // Duplicate all chats for this build
    const chatIdMapping = await storage.duplicateResourceChats(buildId, newBuild.id);

    // Duplicate Editor state if it exists, mapping lastChatId to the cloned chat
    const sourceEditorState = await storage.getEditorState(buildId);
    if (sourceEditorState) {
      const newLastChatId = sourceEditorState.lastChatId ? chatIdMapping[sourceEditorState.lastChatId] : undefined;
      await storage.updateEditorState({
        buildId: newBuild.id,
        openFiles: sourceEditorState.openFiles,
        activeFilePath: sourceEditorState.activeFilePath,
        lastChatId: newLastChatId,
      });
    }

    return newBuild;
  },

  async updateBuild(
    buildId: string,
    update: PartialDeep<Build>,
    options?: {
      ignoreKeys?: string[];
      noUpdatedAt?: boolean;
    },
  ): Promise<Build | undefined> {
    return storage.updateBuild(buildId, update, options);
  },

  async getBuilds(options?: { includeDeleted?: boolean }): Promise<Build[]> {
    return storage.getBuilds(options);
  },

  async getBuild(buildId: string): Promise<Build | undefined> {
    return storage.getBuild(buildId);
  },

  async deleteBuild(buildId: string): Promise<void> {
    // Delete all chats associated with the build
    const chats = await storage.getChatsForResource(buildId, { includeDeleted: true });
    await Promise.all(chats.map(async (chat) => storage.deleteChat(chat.id)));

    // Delete the Editor state for the build
    await storage.deleteEditorState(buildId);

    // Delete the build itself
    return storage.deleteBuild(buildId);
  },

  // ============================================================================
  // Chat Methods
  // ============================================================================

  async createChat(
    resourceId: string,
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<Chat> {
    return storage.createChat(resourceId, chat);
  },

  async updateChat(
    chatId: string,
    update: PartialDeep<Chat>,
    options?: { ignoreKeys?: string[]; noUpdatedAt?: boolean },
  ): Promise<Chat | undefined> {
    return storage.updateChat(chatId, update, options);
  },

  async getChat(chatId: string): Promise<Chat | undefined> {
    return storage.getChat(chatId);
  },

  async getChatsForResource(resourceId: string, options?: { includeDeleted?: boolean }): Promise<Chat[]> {
    return storage.getChatsForResource(resourceId, options);
  },

  async deleteChat(chatId: string): Promise<void> {
    return storage.deleteChat(chatId);
  },

  async duplicateChat(chatId: string): Promise<Chat> {
    return storage.duplicateChat(chatId);
  },

  async duplicateResourceChats(sourceResourceId: string, targetResourceId: string): Promise<Record<string, string>> {
    return storage.duplicateResourceChats(sourceResourceId, targetResourceId);
  },

  // ============================================================================
  // Editor State Methods
  // ============================================================================

  async getEditorState(buildId: string): Promise<EditorState | undefined> {
    return storage.getEditorState(buildId);
  },

  async updateEditorState(editorState: EditorStateInput): Promise<EditorState> {
    return storage.updateEditorState(editorState);
  },

  async deleteEditorState(buildId: string): Promise<void> {
    return storage.deleteEditorState(buildId);
  },
};

expose(objectStoreWorker);

export type ObjectStoreWorker = typeof objectStoreWorker;
