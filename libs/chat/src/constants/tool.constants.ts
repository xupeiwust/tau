export const toolName = {
  webSearch: 'web_search',
  webBrowser: 'web_browser',
  testModel: 'test_model',
  editTests: 'edit_tests',
  captureObservations: 'capture_observations', // Internal tool used by test_model
  readFile: 'read_file',
  editFile: 'edit_file',
  listDirectory: 'list_directory',
  createFile: 'create_file',
  deleteFile: 'delete_file',
  grep: 'grep',
  globSearch: 'glob_search',
  getKernelResult: 'get_kernel_result',
  reasoning: 'reasoning',
  transferToCadExpert: 'transfer_to_cad_expert',
  transferToResearchExpert: 'transfer_to_research_expert',
  transferBackToSupervisor: 'transfer_back_to_supervisor',
} as const satisfies Record<string, string>;

export const toolNames = Object.values(toolName) as [(typeof toolName)[keyof typeof toolName]];

/**
 * Client-side RPC operations that are exposed to the LLM and shown in the UI.
 * These operations are executed on the frontend via WebSocket.
 *
 * Note: edit_file, edit_tests, and test_model are NOT included here because they are
 * orchestrated on the backend (they call these client RPCs internally).
 * Server-only tools (transfers, web search) are also NOT included here.
 */
export const clientToolNames = [
  toolName.readFile,
  toolName.listDirectory,
  toolName.createFile,
  toolName.deleteFile,
  toolName.grep,
  toolName.globSearch,
  toolName.getKernelResult,
] as const;

/**
 * Internal RPC operations that are NOT shown in the UI.
 * These are used by backend tools but don't appear as standalone tool calls.
 */
export const internalRpcNames = [toolName.captureObservations] as const;

/**
 * All RPC operations (client + internal).
 * Used for validation in ChatRpcService.
 */
export const allRpcNames = [...clientToolNames, ...internalRpcNames] as const;

export const toolMode = {
  none: 'none',
  auto: 'auto',
  any: 'any',
  custom: 'custom',
} as const satisfies Record<string, string>;

export const toolModes = Object.values(toolMode) as [(typeof toolMode)[keyof typeof toolMode]];
