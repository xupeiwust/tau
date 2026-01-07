import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import { imageAnalysisInputSchema } from '@taucad/chat';
import type { ImageAnalysisOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

const imageAnalysisJsonSchema = z.toJSONSchema(imageAnalysisInputSchema);

export const imageAnalysisToolDefinition = {
  name: toolName.imageAnalysis,
  description: `Visually validate a CAD model against specific requirements.

Captures 6 individual orthographic view observations (FRONT, BACK, RIGHT, LEFT, TOP, BOTTOM), analyzes each in parallel against the provided requirements, and aggregates results using a 67% consensus threshold.

Returns:
- observations: Array of captured images with id, side, and src
- observationResults: Per-observation analysis results matched by ID
- aggregatedResults: Combined results (requirement passes if 4+/6 views agree)
- evaluationCriteria: Threshold details for transparency`,
  schema: imageAnalysisJsonSchema,
} as const;

export const imageAnalysisTool = tool(async (args) => {
  const data = interrupt<unknown, ImageAnalysisOutput>(args);

  // Return the full output from the client (observations, observationResults, aggregatedResults, evaluationCriteria)
  return data;
}, imageAnalysisToolDefinition);
