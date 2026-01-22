import type { z } from 'zod';
import { toolName } from '#constants/tool.constants.js';
import { listDirectoryInputSchema, listDirectoryOutputSchema } from '#schemas/tools/list-directory.tool.schema.js';
import type { ListDirectoryInput, ListDirectoryOutput } from '#schemas/tools/list-directory.tool.schema.js';
import { readFileInputSchema, readFileOutputSchema } from '#schemas/tools/read-file.tool.schema.js';
import type { ReadFileInput, ReadFileOutput } from '#schemas/tools/read-file.tool.schema.js';
import { createFileInputSchema, createFileOutputSchema } from '#schemas/tools/create-file.tool.schema.js';
import type { CreateFileInput, CreateFileOutput } from '#schemas/tools/create-file.tool.schema.js';
import { deleteFileInputSchema, deleteFileOutputSchema } from '#schemas/tools/delete-file.tool.schema.js';
import type { DeleteFileInput, DeleteFileOutput } from '#schemas/tools/delete-file.tool.schema.js';
import { grepInputSchema, grepOutputSchema } from '#schemas/tools/grep.tool.schema.js';
import type { GrepInput, GrepOutput } from '#schemas/tools/grep.tool.schema.js';
import { globSearchInputSchema, globSearchOutputSchema } from '#schemas/tools/glob-search.tool.schema.js';
import type { GlobSearchInput, GlobSearchOutput } from '#schemas/tools/glob-search.tool.schema.js';
import {
  getKernelResultInputSchema,
  getKernelResultOutputSchema,
} from '#schemas/tools/get-kernel-result.tool.schema.js';
import type { GetKernelResultInput, GetKernelResultOutput } from '#schemas/tools/get-kernel-result.tool.schema.js';
import {
  captureObservationsInputSchema,
  captureObservationsOutputSchema,
} from '#schemas/tools/capture-observations.tool.schema.js';
import type {
  CaptureObservationsInput,
  CaptureObservationsOutput,
} from '#schemas/tools/capture-observations.tool.schema.js';
import type { TestModelOutput } from '#schemas/tools/test-model.tool.schema.js';
import type { EditFileOutput } from '#schemas/tools/edit-file.tool.schema.js';

type ToolSchemaEntry<Input = unknown, Output = unknown> = {
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
};

/**
 * Type representing the client tool schemas registry.
 * Used for type inference in sendToolCallRequest for WebSocket RPC tools.
 */
export type ClientToolSchemasRegistry = {
  [toolName.listDirectory]: ToolSchemaEntry<ListDirectoryInput, ListDirectoryOutput>;
  [toolName.readFile]: ToolSchemaEntry<ReadFileInput, ReadFileOutput>;
  [toolName.createFile]: ToolSchemaEntry<CreateFileInput, CreateFileOutput>;
  [toolName.deleteFile]: ToolSchemaEntry<DeleteFileInput, DeleteFileOutput>;
  [toolName.grep]: ToolSchemaEntry<GrepInput, GrepOutput>;
  [toolName.globSearch]: ToolSchemaEntry<GlobSearchInput, GlobSearchOutput>;
  [toolName.getKernelResult]: ToolSchemaEntry<GetKernelResultInput, GetKernelResultOutput>;
  [toolName.captureObservations]: ToolSchemaEntry<CaptureObservationsInput, CaptureObservationsOutput>;
};

/**
 * Runtime registry mapping client tool names to their Zod schemas.
 * Used by ChatToolsService for validating WebSocket RPC tool inputs/outputs.
 */
export const clientToolSchemasRegistry: ClientToolSchemasRegistry = {
  [toolName.listDirectory]: {
    inputSchema: listDirectoryInputSchema,
    outputSchema: listDirectoryOutputSchema,
  },
  [toolName.readFile]: {
    inputSchema: readFileInputSchema,
    outputSchema: readFileOutputSchema,
  },
  [toolName.createFile]: {
    inputSchema: createFileInputSchema,
    outputSchema: createFileOutputSchema,
  },
  [toolName.deleteFile]: {
    inputSchema: deleteFileInputSchema,
    outputSchema: deleteFileOutputSchema,
  },
  [toolName.grep]: {
    inputSchema: grepInputSchema,
    outputSchema: grepOutputSchema,
  },
  [toolName.globSearch]: {
    inputSchema: globSearchInputSchema,
    outputSchema: globSearchOutputSchema,
  },
  [toolName.getKernelResult]: {
    inputSchema: getKernelResultInputSchema,
    outputSchema: getKernelResultOutputSchema,
  },
  [toolName.captureObservations]: {
    inputSchema: captureObservationsInputSchema,
    outputSchema: captureObservationsOutputSchema,
  },
};

/**
 * Helper type to extract input type for a given client tool name.
 */
export type ClientToolInput<T extends keyof ClientToolSchemasRegistry> = z.infer<
  ClientToolSchemasRegistry[T]['inputSchema']
>;

/**
 * Helper type to extract output type for a given client tool name.
 */
export type ClientToolOutput<T extends keyof ClientToolSchemasRegistry> = z.infer<
  ClientToolSchemasRegistry[T]['outputSchema']
>;

/**
 * Type-only registry mapping tool names to their output types.
 * Used for type inference in tool result trimmers (no runtime validation needed
 * since validation happens upstream in ChatToolsService).
 *
 * Includes both client tools and server-orchestrated tools that produce trimmable output.
 */
export type ToolOutputRegistry = {
  [toolName.testModel]: TestModelOutput;
  [toolName.createFile]: CreateFileOutput;
  [toolName.editFile]: EditFileOutput;
  [toolName.getKernelResult]: GetKernelResultOutput;
  [toolName.captureObservations]: CaptureObservationsOutput;
  [toolName.readFile]: ReadFileOutput;
  [toolName.listDirectory]: ListDirectoryOutput;
  [toolName.grep]: GrepOutput;
  [toolName.globSearch]: GlobSearchOutput;
};
