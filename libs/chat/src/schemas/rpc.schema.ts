/**
 * RPC Schemas for Client-Side Operations
 *
 * This file defines discriminated result types for RPC operations executed
 * via WebSocket between the backend and frontend. Each RPC operation returns
 * a discriminated union with `success: true` for success cases and
 * `success: false` with error details for failures.
 *
 * The rpcSchemasRegistry is used by ChatRpcService for validating inputs and results.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import { toolName } from '#constants/tool.constants.js';
import { diffStatsWithContentSchema } from '#schemas/tools/diff.schema.js';
import { kernelIssueSchema } from '#schemas/tools/issue.schema.js';
import { observationSchema } from '#schemas/tools/test-model.tool.schema.js';

// =============================================================================
// RPC Error Types
// =============================================================================

/**
 * Error codes for business-level RPC failures.
 * These are distinct from infrastructure errors (timeout, disconnect) which
 * are handled by ToolExecutionError.
 */
export const rpcErrorCodeSchema = zod.enum([
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'IO_ERROR',
  'PARSE_ERROR',
  'UNKNOWN',
]);

/**
 * Base error schema for all RPC failures.
 * Used as the error variant in discriminated unions.
 */
export const rpcErrorSchema = zod.object({
  success: zod.literal(false),
  errorCode: rpcErrorCodeSchema,
  message: zod.string(),
});

// =============================================================================
// ReadFile RPC
// =============================================================================

export const readFileRpcInputSchema = zod.object({
  targetFile: zod.string(),
  offset: zod.number().optional(),
  limit: zod.number().optional(),
});

export const readFileRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  content: zod.string(),
  totalLines: zod.number(),
  startLine: zod.number().optional(),
});

export const readFileRpcResultSchema = zod.discriminatedUnion('success', [readFileRpcSuccessSchema, rpcErrorSchema]);

// =============================================================================
// CreateFile RPC
// =============================================================================

export const createFileRpcInputSchema = zod.object({
  targetFile: zod.string(),
  content: zod.string(),
});

export const createFileRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  message: zod.string().optional(),
  diffStats: diffStatsWithContentSchema,
});

export const createFileRpcResultSchema = zod.discriminatedUnion('success', [
  createFileRpcSuccessSchema,
  rpcErrorSchema,
]);

// =============================================================================
// DeleteFile RPC
// =============================================================================

export const deleteFileRpcInputSchema = zod.object({
  targetFile: zod.string(),
});

export const deleteFileRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  message: zod.string(),
});

export const deleteFileRpcResultSchema = zod.discriminatedUnion('success', [
  deleteFileRpcSuccessSchema,
  rpcErrorSchema,
]);

// =============================================================================
// ListDirectory RPC
// =============================================================================

export const listDirectoryRpcInputSchema = zod.object({
  path: zod.string(),
});

const directoryEntrySchema = zod.object({
  name: zod.string(),
  type: zod.enum(['file', 'dir']),
  size: zod.number(),
});

export const listDirectoryRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  entries: zod.array(directoryEntrySchema),
  path: zod.string(),
});

export const listDirectoryRpcResultSchema = zod.discriminatedUnion('success', [
  listDirectoryRpcSuccessSchema,
  rpcErrorSchema,
]);

// =============================================================================
// Grep RPC
// =============================================================================

export const grepRpcInputSchema = zod.object({
  pattern: zod.string(),
  path: zod.string().optional(),
  glob: zod.string().optional(),
  caseSensitive: zod.boolean().optional(),
});

const grepMatchSchema = zod.object({
  file: zod.string(),
  line: zod.number(),
  content: zod.string(),
});

export const grepRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  matches: zod.array(grepMatchSchema),
  totalMatches: zod.number(),
  truncated: zod.boolean().optional(),
});

export const grepRpcResultSchema = zod.discriminatedUnion('success', [grepRpcSuccessSchema, rpcErrorSchema]);

// =============================================================================
// GlobSearch RPC
// =============================================================================

export const globSearchRpcInputSchema = zod.object({
  pattern: zod.string(),
  path: zod.string().optional(),
});

export const globSearchRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  files: zod.array(zod.string()),
  totalFiles: zod.number(),
});

export const globSearchRpcResultSchema = zod.discriminatedUnion('success', [
  globSearchRpcSuccessSchema,
  rpcErrorSchema,
]);

// =============================================================================
// GetKernelResult RPC
// =============================================================================

export const getKernelResultRpcInputSchema = zod.object({
  targetFile: zod.string(),
});

export const getKernelResultRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  status: zod.enum(['ready', 'error', 'pending']),
  kernelIssues: zod.array(kernelIssueSchema).optional(),
});

export const getKernelResultRpcResultSchema = zod.discriminatedUnion('success', [
  getKernelResultRpcSuccessSchema,
  rpcErrorSchema,
]);

// =============================================================================
// CaptureObservations RPC (Internal - used by test_model)
// =============================================================================

export const captureObservationsRpcInputSchema = zod.object({});

export const captureObservationsRpcSuccessSchema = zod.object({
  success: zod.literal(true),
  observations: zod.array(observationSchema),
});

export const captureObservationsRpcResultSchema = zod.discriminatedUnion('success', [
  captureObservationsRpcSuccessSchema,
  rpcErrorSchema,
]);

// =============================================================================
// RPC Schemas Registry
// =============================================================================

type RpcSchemaEntry<Input = unknown, Result = unknown> = {
  inputSchema: zod.ZodType<Input>;
  resultSchema: zod.ZodType<Result>;
};

/**
 * Type representing the RPC schemas registry.
 * Used for type inference in sendRpcRequest.
 */
export type RpcSchemasRegistry = {
  [toolName.readFile]: RpcSchemaEntry<ReadFileRpcInput, ReadFileRpcResult>;
  [toolName.createFile]: RpcSchemaEntry<CreateFileRpcInput, CreateFileRpcResult>;
  [toolName.deleteFile]: RpcSchemaEntry<DeleteFileRpcInput, DeleteFileRpcResult>;
  [toolName.listDirectory]: RpcSchemaEntry<ListDirectoryRpcInput, ListDirectoryRpcResult>;
  [toolName.grep]: RpcSchemaEntry<GrepRpcInput, GrepRpcResult>;
  [toolName.globSearch]: RpcSchemaEntry<GlobSearchRpcInput, GlobSearchRpcResult>;
  [toolName.getKernelResult]: RpcSchemaEntry<GetKernelResultRpcInput, GetKernelResultRpcResult>;
  [toolName.captureObservations]: RpcSchemaEntry<CaptureObservationsRpcInput, CaptureObservationsRpcResult>;
};

/**
 * Runtime registry mapping RPC names to their Zod schemas.
 * Used by ChatRpcService for validating WebSocket RPC inputs/results.
 */
export const rpcSchemasRegistry: RpcSchemasRegistry = {
  [toolName.readFile]: {
    inputSchema: readFileRpcInputSchema,
    resultSchema: readFileRpcResultSchema,
  },
  [toolName.createFile]: {
    inputSchema: createFileRpcInputSchema,
    resultSchema: createFileRpcResultSchema,
  },
  [toolName.deleteFile]: {
    inputSchema: deleteFileRpcInputSchema,
    resultSchema: deleteFileRpcResultSchema,
  },
  [toolName.listDirectory]: {
    inputSchema: listDirectoryRpcInputSchema,
    resultSchema: listDirectoryRpcResultSchema,
  },
  [toolName.grep]: {
    inputSchema: grepRpcInputSchema,
    resultSchema: grepRpcResultSchema,
  },
  [toolName.globSearch]: {
    inputSchema: globSearchRpcInputSchema,
    resultSchema: globSearchRpcResultSchema,
  },
  [toolName.getKernelResult]: {
    inputSchema: getKernelResultRpcInputSchema,
    resultSchema: getKernelResultRpcResultSchema,
  },
  [toolName.captureObservations]: {
    inputSchema: captureObservationsRpcInputSchema,
    resultSchema: captureObservationsRpcResultSchema,
  },
};

// =============================================================================
// Helper Types
// =============================================================================

/**
 * Extract input type for a given RPC name.
 */
export type RpcInput<T extends keyof RpcSchemasRegistry> = z.infer<RpcSchemasRegistry[T]['inputSchema']>;

/**
 * Extract result type for a given RPC name.
 */
export type RpcResult<T extends keyof RpcSchemasRegistry> = z.infer<RpcSchemasRegistry[T]['resultSchema']>;

// =============================================================================
// Inferred Types
// =============================================================================

export type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;
export type RpcError = z.infer<typeof rpcErrorSchema>;

export type ReadFileRpcInput = z.infer<typeof readFileRpcInputSchema>;
export type ReadFileRpcSuccess = z.infer<typeof readFileRpcSuccessSchema>;
export type ReadFileRpcResult = z.infer<typeof readFileRpcResultSchema>;

export type CreateFileRpcInput = z.infer<typeof createFileRpcInputSchema>;
export type CreateFileRpcSuccess = z.infer<typeof createFileRpcSuccessSchema>;
export type CreateFileRpcResult = z.infer<typeof createFileRpcResultSchema>;

export type DeleteFileRpcInput = z.infer<typeof deleteFileRpcInputSchema>;
export type DeleteFileRpcSuccess = z.infer<typeof deleteFileRpcSuccessSchema>;
export type DeleteFileRpcResult = z.infer<typeof deleteFileRpcResultSchema>;

export type ListDirectoryRpcInput = z.infer<typeof listDirectoryRpcInputSchema>;
export type ListDirectoryRpcSuccess = z.infer<typeof listDirectoryRpcSuccessSchema>;
export type ListDirectoryRpcResult = z.infer<typeof listDirectoryRpcResultSchema>;

export type GrepRpcInput = z.infer<typeof grepRpcInputSchema>;
export type GrepRpcSuccess = z.infer<typeof grepRpcSuccessSchema>;
export type GrepRpcResult = z.infer<typeof grepRpcResultSchema>;

export type GlobSearchRpcInput = z.infer<typeof globSearchRpcInputSchema>;
export type GlobSearchRpcSuccess = z.infer<typeof globSearchRpcSuccessSchema>;
export type GlobSearchRpcResult = z.infer<typeof globSearchRpcResultSchema>;

export type GetKernelResultRpcInput = z.infer<typeof getKernelResultRpcInputSchema>;
export type GetKernelResultRpcSuccess = z.infer<typeof getKernelResultRpcSuccessSchema>;
export type GetKernelResultRpcResult = z.infer<typeof getKernelResultRpcResultSchema>;

export type CaptureObservationsRpcInput = z.infer<typeof captureObservationsRpcInputSchema>;
export type CaptureObservationsRpcSuccess = z.infer<typeof captureObservationsRpcSuccessSchema>;
export type CaptureObservationsRpcResult = z.infer<typeof captureObservationsRpcResultSchema>;
