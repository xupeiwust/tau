import { Injectable } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import type { ReactAgent } from 'langchain';
import { streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigService } from '@nestjs/config';
import type { KernelProvider } from '@taucad/types';
import type { ToolSelection } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { ModelService } from '#api/models/model.service.js';
import { usageTrackingMiddleware } from '#api/chat/middleware/usage-tracking.middleware.js';
import { ToolService } from '#api/tools/tool.service.js';
import { buildNameGenerationSystemPrompt } from '#api/chat/prompts/cad-name.prompt.js';
import { commitMessageGenerationSystemPrompt } from '#api/chat/prompts/git-commit.prompt.js';
import { getCadSystemPrompt } from '#api/chat/prompts/cad-agent.prompt.js';
import type { Environment } from '#config/environment.config.js';

@Injectable()
export class ChatService {
  public constructor(
    private readonly modelService: ModelService,
    private readonly toolService: ToolService,
    private readonly configService: ConfigService<Environment, true>,
  ) {}

  public getBuildNameGenerator(coreMessages: ModelMessage[]): ReturnType<typeof streamText> {
    return streamText({
      model: openai('gpt-4o-mini'),
      messages: coreMessages,
      system: buildNameGenerationSystemPrompt,
    });
  }

  public getCommitMessageGenerator(coreMessages: ModelMessage[]): ReturnType<typeof streamText> {
    return streamText({
      model: openai('gpt-4o-mini'),
      messages: coreMessages,
      system: commitMessageGenerationSystemPrompt,
    });
  }

  public async createAgent(
    modelId: string,
    selectedToolChoice: ToolSelection,
    selectedKernel: KernelProvider,
  ): Promise<ReactAgent> {
    const { tools } = this.toolService.getTools(selectedToolChoice);

    const databaseUrl = this.configService.get('DATABASE_URL', { infer: true });
    const checkpointer = PostgresSaver.fromConnString(databaseUrl, {
      schema: 'langgraph',
    });
    await checkpointer.setup();

    const { model } = this.modelService.buildModel(modelId);

    // Combine all tools into a single array for the unified agent
    const allTools = [
      // CAD and filesystem tools
      tools.edit_file,
      tools.analyze_image,
      tools.read_file,
      tools.list_directory,
      tools.create_file,
      tools.delete_file,
      tools.grep,
      tools.glob_search,
      tools.get_kernel_result,
      tools.reasoning,
      // Research tools
      tools.web_search,
      tools.web_browser,
    ].filter((tool) => tool !== undefined);

    // Build the unified system prompt
    const cadSystemPrompt = await getCadSystemPrompt(selectedKernel);
    const unifiedSystemPrompt = `${cadSystemPrompt}

<research_capabilities>
## Web Research Tools
You also have access to web research tools for gathering information:

- **\`${toolName.webSearch}\`**: Search the web for current information, documentation, tutorials, or any external knowledge needed to complete your task. Use this when you need to look up technical details, find examples, or research best practices.

- **\`${toolName.webBrowser}\`**: Browse specific web pages to extract detailed information. Use this only when the web search results are insufficient and you need to dive deeper into a specific URL.

**When to use research tools:**
- When you need current information about libraries, APIs, or techniques
- When the user asks about topics outside your training data
- When you need to look up specifications, dimensions, or reference materials for CAD models
- When researching best practices for specific manufacturing techniques

Always prefer \`${toolName.webSearch}\` first, and only use \`${toolName.webBrowser}\` if the search results don't provide enough detail.
</research_capabilities>`;

    // Create a unified agent with createAgent from LangChain v1
    // Uses systemPrompt (string) instead of prompt (SystemMessage)
    // Uses model instead of llm, and does NOT use pre-bound models with tools
    const agent = createAgent({
      model,
      tools: allTools,
      systemPrompt: unifiedSystemPrompt,
      checkpointer,
      middleware: [
        // Track token usage and costs after each model call
        usageTrackingMiddleware,
        // Handle tool interrupts - our tools use interrupt() from @langchain/langgraph
        // The middleware manages the human-in-the-loop flow automatically
        humanInTheLoopMiddleware({}),
      ],
    });

    return agent;
  }
}
