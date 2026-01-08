import type { KernelIssue } from '@taucad/types';
import { z } from 'zod';
import { kernelIssueSchema } from '#schemas/tools/issue.schema.js';

export const getKernelResultInputSchema = z.object({
  targetFile: z.string().optional().describe('Optional file to check. If omitted, checks the current/main file.'),
});

export const getKernelResultOutputSchema = z.object({
  status: z.enum(['ready', 'error', 'pending']).describe('The current status of the kernel.'),
  kernelIssues: z.array(kernelIssueSchema).optional().describe('Any kernel issues encountered during compilation.'),
  message: z.string().optional().describe('Additional status message.'),
});

export type GetKernelResultInput = z.infer<typeof getKernelResultInputSchema>;

// Explicitly defined to avoid TS2742 with tsgo compiler
export type GetKernelResultOutput = {
  status: 'ready' | 'error' | 'pending';
  kernelIssues?: KernelIssue[];
  message?: string;
};
