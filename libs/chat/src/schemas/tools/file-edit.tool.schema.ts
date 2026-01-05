import { z } from 'zod';
import { codeErrorSchema, kernelErrorSchema } from '#schemas/tools/error.schema.js';

export const fileEditInputSchema = z.object({
  targetFile: z.string().describe('The target file to modify.'),
  codeEdit: z.string().describe('Specify ONLY the precise lines of code that you wish to edit...'),
});

export const fileEditOutputSchema = z.object({
  codeErrors: z.array(codeErrorSchema),
  kernelErrors: z.array(kernelErrorSchema).optional(),
});

export type FileEditInput = z.infer<typeof fileEditInputSchema>;
export type FileEditOutput = z.infer<typeof fileEditOutputSchema>;
