import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import { reasoningInputSchema } from '@taucad/chat';
import type { ReasoningOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';

const reasoningJsonSchema = z.toJSONSchema(reasoningInputSchema);

export const reasoningToolDefinition = {
  name: toolName.reasoning,
  description: `Use this tool to think through complex problems step-by-step before taking action.

When to use:
- Before implementing complex multi-step solutions
- When the request requires careful planning or analysis
- To break down ambiguous requirements into concrete steps
- When deciding between multiple approaches

Your thinking should include:
- Analysis of the problem and requirements
- Consideration of different approaches
- Step-by-step plan for implementation
- Potential issues or edge cases to handle

The thinking content will be displayed to the user in a collapsible section, allowing them to understand your reasoning process.`,
  schema: reasoningJsonSchema,
} as const;

export const reasoningTool = tool((args) => {
  const result = interrupt<unknown, ReasoningOutput>(args);
  return result;
}, reasoningToolDefinition);
