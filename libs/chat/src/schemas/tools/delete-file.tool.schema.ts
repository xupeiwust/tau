import { z } from 'zod';

export const deleteFileInputSchema = z.object({
  targetFile: z.string().describe('The path of the file to delete, relative to the project root.'),
});

export const deleteFileOutputSchema = z.object({
  success: z.boolean().describe('Whether the file was deleted successfully.'),
  message: z.string().optional().describe('Additional information about the operation.'),
});

export type DeleteFileInput = z.infer<typeof deleteFileInputSchema>;
export type DeleteFileOutput = z.infer<typeof deleteFileOutputSchema>;
