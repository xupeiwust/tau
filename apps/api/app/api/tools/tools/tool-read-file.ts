import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import { readFileInputSchema } from '@taucad/chat';
import type { ReadFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

const readFileJsonSchema = z.toJSONSchema(readFileInputSchema);

export const readFileToolDefinition = {
  name: toolName.readFile,
  description: `Read the contents of a file from the project filesystem.

You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.

Lines in the output are numbered starting at 1, using the format: LINE_NUMBER|LINE_CONTENT.

Use this tool when you need to:
- Examine the contents of a specific file
- Understand existing code before making modifications
- Review configuration files or documentation`,
  schema: readFileJsonSchema,
} as const;

export const readFileTool = tool((args) => {
  const result = interrupt<unknown, ReadFileOutput>(args);
  return result;
}, readFileToolDefinition);
