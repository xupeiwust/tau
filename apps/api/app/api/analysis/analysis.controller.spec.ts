import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { Observation, VisualTestRequirement, TestModelOutput } from '@taucad/chat';
import { AnalysisController } from '#api/analysis/analysis.controller.js';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { AuthGuard } from '#auth/auth.guard.js';

describe('AnalysisController', () => {
  let controller: AnalysisController;
  let analysisService: AnalysisService;
  let module: TestingModule;

  // Mock observations representing 6 orthographic views
  function createMockObservations(): Observation[] {
    return [
      { id: 'front', side: 'front', src: 'data:image/png;base64,front_view_data' },
      { id: 'back', side: 'back', src: 'data:image/png;base64,back_view_data' },
      { id: 'right', side: 'right', src: 'data:image/png;base64,right_view_data' },
      { id: 'left', side: 'left', src: 'data:image/png;base64,left_view_data' },
      { id: 'top', side: 'top', src: 'data:image/png;base64,top_view_data' },
      { id: 'bottom', side: 'bottom', src: 'data:image/png;base64,bottom_view_data' },
    ];
  }

  // Mock visual test requirements
  function createMockRequirements(): VisualTestRequirement[] {
    return [
      { id: 'test-1', description: 'The model should have a rectangular base', type: 'visual' },
      { id: 'test-2', description: 'The model should have rounded corners', type: 'visual' },
      { id: 'test-3', description: 'The model should be approximately 100mm wide', type: 'visual' },
    ];
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    const mockAnalysisService = {
      runVisualTests: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalysisController],
      providers: [
        {
          provide: AnalysisService,
          useValue: mockAnalysisService,
        },
        Reflector,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<AnalysisController>(AnalysisController);
    analysisService = moduleRef.get<AnalysisService>(AnalysisService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('runVisualTests', () => {
    it('should call analysisService.runVisualTests with observations and requirements', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();
      const mockResult: TestModelOutput = {
        failures: [],
        passes: [
          { id: 'test-1', requirement: 'The model should have a rectangular base' },
          { id: 'test-2', requirement: 'The model should have rounded corners' },
          { id: 'test-3', requirement: 'The model should be approximately 100mm wide' },
        ],
        passed: 3,
        total: 3,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({ observations, requirements });

      // Assert
      expect(analysisService.runVisualTests).toHaveBeenCalledWith(observations, requirements);
      expect(analysisService.runVisualTests).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it('should return correct structure when all tests pass', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();
      const mockResult: TestModelOutput = {
        failures: [],
        passes: [
          { id: 'test-1', requirement: 'The model should have a rectangular base' },
          { id: 'test-2', requirement: 'The model should have rounded corners' },
          { id: 'test-3', requirement: 'The model should be approximately 100mm wide' },
        ],
        passed: 3,
        total: 3,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({ observations, requirements });

      // Assert
      expect(result.passed).toBe(3);
      expect(result.total).toBe(3);
      expect(result.failures).toHaveLength(0);
      expect(result.passes).toHaveLength(3);
    });

    it('should return failures with reason and suggestion when tests fail', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();
      const mockResult: TestModelOutput = {
        failures: [
          {
            id: 'test-2',
            requirement: 'The model should have rounded corners',
            reason: 'The corners appear to be sharp, not rounded',
            suggestion: 'Use fillet or chamfer on the corner edges',
          },
        ],
        passes: [
          { id: 'test-1', requirement: 'The model should have a rectangular base' },
          { id: 'test-3', requirement: 'The model should be approximately 100mm wide' },
        ],
        passed: 2,
        total: 3,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({ observations, requirements });

      // Assert
      expect(result.passed).toBe(2);
      expect(result.total).toBe(3);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toEqual({
        id: 'test-2',
        requirement: 'The model should have rounded corners',
        reason: 'The corners appear to be sharp, not rounded',
        suggestion: 'Use fillet or chamfer on the corner edges',
      });
    });

    it('should handle all tests failing', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();
      const mockResult: TestModelOutput = {
        failures: [
          {
            id: 'test-1',
            requirement: 'The model should have a rectangular base',
            reason: 'Base is circular',
            suggestion: 'Change the base shape',
          },
          {
            id: 'test-2',
            requirement: 'The model should have rounded corners',
            reason: 'No corners visible',
            suggestion: 'Add corner features',
          },
          {
            id: 'test-3',
            requirement: 'The model should be approximately 100mm wide',
            reason: 'Model appears too small',
            suggestion: 'Scale up the model',
          },
        ],
        passes: [],
        passed: 0,
        total: 3,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({ observations, requirements });

      // Assert
      expect(result.passed).toBe(0);
      expect(result.total).toBe(3);
      expect(result.failures).toHaveLength(3);
      expect(result.passes).toHaveLength(0);
    });

    it('should propagate errors from analysisService', async () => {
      // Arrange
      const observations = createMockObservations();
      const requirements = createMockRequirements();
      const testError = new Error('LLM API connection failed');

      vi.mocked(analysisService.runVisualTests).mockRejectedValue(testError);

      // Act & Assert
      await expect(controller.runVisualTests({ observations, requirements })).rejects.toThrow(
        'LLM API connection failed',
      );
    });

    it('should handle partial observations (less than 6 views)', async () => {
      // Arrange
      const partialObservations: Observation[] = [
        { id: 'front', side: 'front', src: 'data:image/png;base64,front_view_data' },
        { id: 'top', side: 'top', src: 'data:image/png;base64,top_view_data' },
      ];
      const requirements = createMockRequirements();
      const mockResult: TestModelOutput = {
        failures: [],
        passes: [{ id: 'test-1', requirement: 'Test requirement' }],
        passed: 1,
        total: 1,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({
        observations: partialObservations,
        requirements: [requirements[0]!],
      });

      // Assert
      expect(analysisService.runVisualTests).toHaveBeenCalledWith(partialObservations, [requirements[0]]);
      expect(result).toEqual(mockResult);
    });

    it('should handle single requirement', async () => {
      // Arrange
      const observations = createMockObservations();
      const singleRequirement: VisualTestRequirement[] = [
        { id: 'single-test', description: 'The model should exist', type: 'visual' },
      ];
      const mockResult: TestModelOutput = {
        failures: [],
        passes: [{ id: 'single-test', requirement: 'The model should exist' }],
        passed: 1,
        total: 1,
      };

      vi.mocked(analysisService.runVisualTests).mockResolvedValue(mockResult);

      // Act
      const result = await controller.runVisualTests({
        observations,
        requirements: singleRequirement,
      });

      // Assert
      expect(result.passed).toBe(1);
      expect(result.total).toBe(1);
    });
  });
});
