import { z } from 'zod';

export const readFileInputSchema = z.object({
  targetFile: z.string().describe('The path of the file to read, relative to the project root.'),
  offset: z
    .number()
    .optional()
    .describe('The line number to start reading from (1-based). If not provided, reads from the beginning.'),
  limit: z.number().optional().describe('The maximum number of lines to read. If not provided, reads the entire file.'),
});

export const readFileOutputSchema = z.object({
  content: z.string().describe('The content of the file with line numbers prefixed.'),
  totalLines: z.number().describe('The total number of lines in the file.'),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type ReadFileOutput = z.infer<typeof readFileOutputSchema>;
