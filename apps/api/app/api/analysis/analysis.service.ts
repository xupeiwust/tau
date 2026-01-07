import { Injectable, Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Observation, ObservationResult, RequirementResult, EvaluationCriteria } from '@taucad/chat';
import { requirementResultSchema } from '@taucad/chat';
import { createImageAnalysisSystemPrompt } from '#api/analysis/prompts/image-analysis-prompt.js';

/**
 * Response from analyzing multiple observations
 */
export type AnalyzeObservationsResponse = {
  observationResults: ObservationResult[];
  aggregatedResults: RequirementResult[];
  evaluationCriteria: EvaluationCriteria;
};

/**
 * Service for analyzing CAD model observations (screenshots from different views)
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  /**
   * Analyze multiple observations in parallel and aggregate results.
   *
   * @param observations - Array of observations (each with id, side, src)
   * @param requirements - Array of requirement strings to verify
   * @returns Aggregated analysis results with per-observation details
   */
  public async analyzeObservations(
    observations: Observation[],
    requirements: string[],
  ): Promise<AnalyzeObservationsResponse> {
    this.logger.log(`Analyzing ${observations.length} observations against ${requirements.length} requirements`);
    this.logger.debug(
      'Observation IDs:',
      observations.map((observation) => observation.id),
    );
    this.logger.debug('Requirements:', requirements);

    // Run all analyses in parallel
    this.logger.log('Starting parallel analysis of all observations...');
    const observationResults = await Promise.all(
      observations.map(async (observation) => this.analyzeObservation(observation, requirements)),
    );
    this.logger.log('All observations analyzed successfully');

    // Aggregate results per requirement using 67% threshold
    const thresholdPercentage = 67;
    const thresholdCount = Math.ceil(observations.length * (thresholdPercentage / 100));

    const aggregatedResults: RequirementResult[] = requirements.map((requirement, requirementIndex) => {
      // Count how many observations marked this requirement as passed
      const passCount = observationResults.filter((observationResult) => {
        const result = observationResult.results[requirementIndex];
        return result?.status === 'passed';
      }).length;

      if (passCount >= thresholdCount) {
        return {
          status: 'passed' as const,
          requirement,
        };
      }

      // Find a failed result to use for reason/suggestion
      const failedResult = observationResults.find((observationResult) => {
        const result = observationResult.results[requirementIndex];
        return result?.status === 'failed';
      })?.results[requirementIndex];

      return {
        status: 'failed' as const,
        requirement,
        reason:
          failedResult?.status === 'failed'
            ? `${passCount}/${observations.length} views passed. ${failedResult.reason}`
            : `${passCount}/${observations.length} views passed (below ${thresholdPercentage}% threshold)`,
        suggestion: failedResult?.status === 'failed' ? failedResult.suggestion : 'Review the failed views for details',
      };
    });

    const evaluationCriteria: EvaluationCriteria = {
      totalObservations: observations.length,
      thresholdPercentage,
      thresholdCount,
    };

    return {
      observationResults,
      aggregatedResults,
      evaluationCriteria,
    };
  }

  /**
   * Analyze a single observation against requirements
   */
  private async analyzeObservation(observation: Observation, requirements: string[]): Promise<ObservationResult> {
    this.logger.debug(`Analyzing observation ${observation.id} (${observation.side} view)`);

    const systemPrompt = createImageAnalysisSystemPrompt(observation.side);
    const userPrompt = this.formatRequirementsPrompt(requirements);

    try {
      // Use generateText with Output.object for structured output generation
      // This replaces the deprecated generateObject function and uses OpenAI's strict mode
      const responseSchema = z.object({
        results: z.array(requirementResultSchema),
      });

      const { experimental_output: experimentalOutput } = await generateText({
        model: openai('gpt-4o'),
        // eslint-disable-next-line @typescript-eslint/naming-convention -- AI SDK uses snake_case for experimental API
        experimental_output: Output.object({
          schema: responseSchema,
        }),
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image', image: observation.src },
            ],
          },
        ],
      });

      return {
        id: observation.id,
        side: observation.side,
        results: experimentalOutput.results,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to analyze observation ${observation.id}: ${errorMessage}`);
      if (error instanceof Error && error.stack) {
        this.logger.debug(`Stack trace: ${error.stack}`);
      }

      // Return failed results for all requirements on error
      return {
        id: observation.id,
        side: observation.side,
        results: requirements.map((requirement) => ({
          status: 'failed' as const,
          requirement,
          reason: `Analysis failed for ${observation.side} view: ${errorMessage}`,
          suggestion: 'Retry the analysis',
        })),
      };
    }
  }

  /**
   * Format requirements into a prompt for the image analyzer
   */
  private formatRequirementsPrompt(requirements: string[]): string {
    const requirementsList = requirements.map((requirement, index) => `${index + 1}. ${requirement}`).join('\n');
    return `Please analyze this CAD model screenshot and verify the following requirements:\n\n${requirementsList}`;
  }
}

