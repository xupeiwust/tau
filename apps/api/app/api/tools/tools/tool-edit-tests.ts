import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { editTestsInputSchema, isRpcError } from '@taucad/chat';
import { isToolExecutionError } from '@taucad/chat/utils';
import type { ChatTool, EditTestsInput, EditTestsOutput, ToolExecutionError } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const editTestsToolDefinition = {
  name: toolName.editTests,
  description: `Edit test.json to add, modify, or remove test requirements.

Uses the same pattern as edit_file - specify edits with // ... existing code ... to represent unchanged sections.

Example edit to add a new requirement:
{
  "requirements": [
    // ... existing code ...
    {
      "id": "req_hole_visible",
      "description": "Circular hole visible through the sphere",
      "type": "visual"
    }
  ]
}

**Requirement guidelines:**
- Describe VISIBLE OUTCOMES, not CAD operations
- Do NOT specify views (FRONT, TOP, etc.) - all 6 orthographic views are analyzed automatically
- Good: "Circular hole visible through sphere", "Smooth curved surface"
- Bad: "TOP view shows hole", "Boolean difference applied"

Use this tool BEFORE making model changes (TDD approach).`,
  schema: editTestsInputSchema,
} as const;

const testFile = 'test.json';

// Default test.json content when file doesn't exist
const defaultTestFile = JSON.stringify(
  {
    requirements: [],
  },
  null,
  2,
);

export const editTestsTool: ChatTool<
  typeof editTestsInputSchema,
  EditTestsInput,
  EditTestsOutput,
  typeof toolName.editTests
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, fileEditService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;
  const { codeEdit } = args;

  // Step 1: Read the current test.json content via RPC
  const readResult = await chatRpcService.sendRpcRequest(chatId, toolCallId, toolName.readFile, {
    targetFile: testFile,
  });

  // Handle infrastructure errors (timeout, disconnect)
  if (isToolExecutionError(readResult)) {
    return readResult;
  }

  // If file doesn't exist (RPC error), use default content
  let originalContent: string;
  if (isRpcError(readResult)) {
    originalContent = defaultTestFile;
  } else {
    originalContent = readResult.content === '' ? defaultTestFile : readResult.content;
  }

  // Step 2: Apply the edit using FileEditService (Morph fast-apply)
  const editResult = await fileEditService.applyFileEdit({
    targetFile: testFile,
    originalContent,
    codeEdit,
    instructions: 'Apply the test requirements edit to test.json',
  });

  if (!editResult.success || !editResult.editedContent) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Failed to apply edit to test.json. The edit pattern may not match the file content.`,
      toolName: toolName.editTests,
      toolCallId,
    };
    return error;
  }

  // Step 3: Write the edited content back via RPC
  const writeResult = await chatRpcService.sendRpcRequest(chatId, toolCallId, toolName.createFile, {
    targetFile: testFile,
    content: editResult.editedContent,
  });

  // Handle infrastructure errors (timeout, disconnect)
  if (isToolExecutionError(writeResult)) {
    return writeResult;
  }

  // Handle RPC business errors (permission denied, etc.)
  if (isRpcError(writeResult)) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Cannot save test.json: ${writeResult.message}`,
      toolName: toolName.editTests,
      toolCallId,
    };
    return error;
  }

  // Return the result with diff stats (no success property)
  const result: EditTestsOutput = {
    diffStats: {
      linesAdded: editResult.diffStats?.linesAdded ?? 0,
      linesRemoved: editResult.diffStats?.linesRemoved ?? 0,
      originalContent,
      modifiedContent: editResult.editedContent,
    },
  };
  return result;
}, editTestsToolDefinition);
