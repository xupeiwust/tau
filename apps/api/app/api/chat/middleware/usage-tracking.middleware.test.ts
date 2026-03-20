import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage } from '@langchain/core/messages';
import { AttributeKey, GenAiTokenType } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';
import { createUsageTrackingMiddleware } from '#api/chat/middleware/usage-tracking.middleware.js';

const mockModelService = mock<ModelService>();
const metricsService = new MetricsService();

vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => 'dat_test_123'),
}));

/* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
const createAIMessageWithUsage = (overrides?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
  responseModel?: string;
  responseModelKey?: 'model' | 'model_name';
}): AIMessage => {
  const {
    inputTokens = 100,
    outputTokens = 50,
    cacheRead = 0,
    cacheCreation = 0,
    reasoning = 0,
    responseModel = 'claude-3-5-sonnet-20241022',
    responseModelKey = 'model',
  } = overrides ?? {};

  return new AIMessage({
    content: 'Test response',
    response_metadata: { [responseModelKey]: responseModel },
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_token_details: {
        cache_read: cacheRead,
        cache_creation: cacheCreation,
      },
      output_token_details: {
        reasoning,
      },
    },
  });
};
/* eslint-enable @typescript-eslint/naming-convention */

describe('createUsageTrackingMiddleware', () => {
  let writer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    writer = vi.fn();
    vi.spyOn(metricsService.genAiTokenUsage, 'record');
    vi.spyOn(metricsService.genAiCost, 'add');

    mockModelService.getOtelProviderName.mockReturnValue('anthropic');
    mockModelService.streamingDoublesCacheTokens.mockReturnValue(false);
    mockModelService.normalizeUsageTokens.mockImplementation((_id, usage) => usage);
    mockModelService.getModelCost.mockReturnValue({
      inputTokensCost: 0.001,
      outputTokensCost: 0.002,
      cacheReadTokensCost: 0,
      cacheWriteTokensCost: 0,
      totalCost: 0.003,
    });
  });

  it('should record raw input tokens in OTEL histogram (not normalized)', () => {
    const middleware = createUsageTrackingMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const aiMessage = createAIMessageWithUsage({ inputTokens: 500, outputTokens: 200 });

    mockModelService.normalizeUsageTokens.mockReturnValue({
      inputTokens: 300,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    afterModel(
      { messages: [aiMessage] } as Parameters<typeof afterModel>[0],
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService }, writer } as unknown as Parameters<
        typeof afterModel
      >[1],
    );

    const calls = (metricsService.genAiTokenUsage.record as ReturnType<typeof vi.fn>).mock.calls;
    const inputCall = calls.find(
      (call: [number, Record<string, string>]) => call[1][AttributeKey.GEN_AI_TOKEN_TYPE] === GenAiTokenType.INPUT,
    ) as [number, Record<string, string>] | undefined;
    const outputCall = calls.find(
      (call: [number, Record<string, string>]) => call[1][AttributeKey.GEN_AI_TOKEN_TYPE] === GenAiTokenType.OUTPUT,
    ) as [number, Record<string, string>] | undefined;

    expect(inputCall?.[0]).toBe(500);
    expect(outputCall?.[0]).toBe(200);
  });

  it('should populate response_model from response_metadata.model (Anthropic)', () => {
    const middleware = createUsageTrackingMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const aiMessage = createAIMessageWithUsage({
      responseModel: 'claude-3-5-sonnet-20241022',
      responseModelKey: 'model',
    });

    afterModel(
      { messages: [aiMessage] } as Parameters<typeof afterModel>[0],
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService }, writer } as unknown as Parameters<
        typeof afterModel
      >[1],
    );

    const [, attributes] = (metricsService.genAiTokenUsage.record as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      Record<string, string>,
    ];
    expect(attributes[AttributeKey.GEN_AI_RESPONSE_MODEL]).toBe('claude-3-5-sonnet-20241022');
  });

  it('should fall back to response_metadata.model_name (OpenAI)', () => {
    const middleware = createUsageTrackingMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const aiMessage = createAIMessageWithUsage({ responseModel: 'gpt-4o-2024-05-13', responseModelKey: 'model_name' });

    afterModel(
      { messages: [aiMessage] } as Parameters<typeof afterModel>[0],
      { context: { modelId: 'gpt-4o', modelService: mockModelService }, writer } as unknown as Parameters<
        typeof afterModel
      >[1],
    );

    const [, attributes] = (metricsService.genAiTokenUsage.record as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      Record<string, string>,
    ];
    expect(attributes[AttributeKey.GEN_AI_RESPONSE_MODEL]).toBe('gpt-4o-2024-05-13');
  });

  it('should increment cost counter when totalCost > 0', () => {
    const middleware = createUsageTrackingMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const aiMessage = createAIMessageWithUsage();

    afterModel(
      { messages: [aiMessage] } as Parameters<typeof afterModel>[0],
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService }, writer } as unknown as Parameters<
        typeof afterModel
      >[1],
    );

    expect(metricsService.genAiCost.add).toHaveBeenCalledWith(
      0.003,
      expect.objectContaining({
        [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      }),
    );
  });

  it('should skip recording when usage_metadata is absent', () => {
    const middleware = createUsageTrackingMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const aiMessage = new AIMessage({ content: 'No usage' });

    afterModel(
      { messages: [aiMessage] } as Parameters<typeof afterModel>[0],
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService }, writer } as unknown as Parameters<
        typeof afterModel
      >[1],
    );

    expect(metricsService.genAiTokenUsage.record).not.toHaveBeenCalled();
    expect(metricsService.genAiCost.add).not.toHaveBeenCalled();
  });

  it('should write usage data to the stream writer', () => {
    const middleware = createUsageTrackingMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const aiMessage = createAIMessageWithUsage();

    afterModel(
      { messages: [aiMessage] } as Parameters<typeof afterModel>[0],
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService }, writer } as unknown as Parameters<
        typeof afterModel
      >[1],
    );

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'usage',
        model: 'claude-3.5-sonnet',
      }),
    );
  });
});
