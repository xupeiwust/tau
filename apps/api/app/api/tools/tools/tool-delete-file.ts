import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import { deleteFileInputSchema } from '@taucad/chat';
import type { DeleteFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

const deleteFileJsonSchema = z.toJSONSchema(deleteFileInputSchema);

export const deleteFileToolDefinition = {
  name: toolName.deleteFile,
  description: `Delete a file from the project filesystem.

Use this tool to:
- Remove unused or obsolete files
- Clean up temporary files
- Remove files that are no longer needed

The operation will fail gracefully if:
- The file doesn't exist
- The operation is rejected for security reasons
- The file cannot be deleted`,
  schema: deleteFileJsonSchema,
} as const;

export const deleteFileTool = tool((args) => {
  const result = interrupt<unknown, DeleteFileOutput>(args);
  return result;
}, deleteFileToolDefinition);
