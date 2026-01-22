import type { RpcError } from '#schemas/rpc.schema.js';

/**
 * Type guard for RPC errors.
 * Use this to discriminate between success and error results.
 *
 * @example
 * ```typescript
 * const result = await chatRpcService.sendRpcRequest(...);
 *
 * if (isToolExecutionError(result)) {
 *   // Infrastructure error (timeout, disconnect)
 *   return result;
 * }
 *
 * if (isRpcError(result)) {
 *   // Business error (file not found, permission denied)
 *   return createToolError(result.message);
 * }
 *
 * // Success - result is narrowed to success type
 * const content = result.content;
 * ```
 */
export function isRpcError(result: { success: boolean }): result is RpcError {
  return !result.success;
}
