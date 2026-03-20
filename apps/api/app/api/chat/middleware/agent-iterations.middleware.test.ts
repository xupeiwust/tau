import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AttributeKey } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';
import { createAgentIterationsMiddleware } from '#api/chat/middleware/agent-iterations.middleware.js';

const mockModelService = mock<ModelService>();
const metricsService = new MetricsService();

describe('createAgentIterationsMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(metricsService.genAiAgentIterations, 'record');
  });

  it('should increment iteration count per afterModel call', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const { afterModel } = middleware;

    if (!afterModel) {
      throw new Error('afterModel is not defined on middleware');
    }

    const state1 = afterModel({ _iterationCount: 0 } as Parameters<typeof afterModel>[0]);
    expect(state1).toEqual({ _iterationCount: 1 });

    const state2 = afterModel({ _iterationCount: 3 } as Parameters<typeof afterModel>[0]);
    expect(state2).toEqual({ _iterationCount: 4 });
  });

  it('should record histogram with correct count and attributes in afterAgent', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const { afterAgent } = middleware;

    if (!afterAgent) {
      throw new Error('afterAgent is not defined on middleware');
    }

    mockModelService.getOtelProviderName.mockReturnValue('anthropic');

    afterAgent(
      { _iterationCount: 5 } as Parameters<typeof afterAgent>[0],
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService } } as Parameters<typeof afterAgent>[1],
    );

    expect(metricsService.genAiAgentIterations.record).toHaveBeenCalledWith(5, {
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'claude-3.5-sonnet',
      [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
    });
  });

  it('should omit provider name when getOtelProviderName returns undefined', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const { afterAgent } = middleware;

    if (!afterAgent) {
      throw new Error('afterAgent is not defined on middleware');
    }

    mockModelService.getOtelProviderName.mockReturnValue(undefined);

    afterAgent(
      { _iterationCount: 2 } as Parameters<typeof afterAgent>[0],
      { context: { modelId: 'test-model', modelService: mockModelService } } as Parameters<typeof afterAgent>[1],
    );

    expect(metricsService.genAiAgentIterations.record).toHaveBeenCalledWith(2, {
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'test-model',
    });
  });

  it('should not record when iteration count is zero', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const { afterAgent } = middleware;

    if (!afterAgent) {
      throw new Error('afterAgent is not defined on middleware');
    }

    afterAgent(
      { _iterationCount: 0 } as Parameters<typeof afterAgent>[0],
      { context: { modelId: 'test-model', modelService: mockModelService } } as Parameters<typeof afterAgent>[1],
    );

    expect(metricsService.genAiAgentIterations.record).not.toHaveBeenCalled();
  });
});
