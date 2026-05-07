import process from 'node:process';

/**
 * Predicate for `describe.skipIf(...)` that returns `true` when any of the
 * supplied environment variable names is missing or empty. Use to gate live
 * provider-key tests so they skip cleanly on machines without credentials.
 *
 * @param names - Environment variable names whose presence is required.
 * @returns `true` when any listed variable is missing/empty (skip), `false`
 *   when all are present (run).
 *
 * @example <caption>Gating a single-provider integration suite.</caption>
 * ```typescript
 * import { requiresEnv } from './skip-helpers.js';
 *
 * describe.skipIf(requiresEnv('ANTHROPIC_API_KEY'))('Anthropic live', () => {
 *   it('streams', () => {});
 * });
 * ```
 */
export const requiresEnv = (...names: string[]): boolean => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.length === 0) {
      return true;
    }
  }
  return false;
};

/**
 * Maps a `<provider>-<model>` ID to the environment variable carrying its
 * credential, used by the model/middleware/web-tools integration tests where
 * `TEST_MODEL_ID` selects the provider at runtime.
 *
 * @param modelId - Provider-prefixed model identifier (e.g.
 *   `anthropic-claude-sonnet-4.6`, `openai-gpt-5`,
 *   `google-gemini-2.5-pro`).
 * @returns Environment variable name that must be present for the model to
 *   run, or `undefined` when the prefix is unrecognised (caller decides
 *   whether to skip or fall back).
 *
 * @example <caption>Resolving the env gate for the active test model.</caption>
 * ```typescript
 * import { providerEnvForModelId, requiresEnv } from './skip-helpers.js';
 *
 * const envVar = providerEnvForModelId('anthropic-claude-sonnet-4.6');
 * // envVar === 'ANTHROPIC_API_KEY'
 * describe.skipIf(envVar === undefined || requiresEnv(envVar))('Live', () => {});
 * ```
 */
export const providerEnvForModelId = (modelId: string): string | undefined => {
  const prefix = modelId.split('-', 1)[0];
  switch (prefix) {
    case 'anthropic': {
      return 'ANTHROPIC_API_KEY';
    }
    case 'openai': {
      return 'OPENAI_API_KEY';
    }
    case 'google':
    case 'vertex': {
      return 'GOOGLE_VERTEX_AI_CREDENTIALS';
    }
    case 'cerebras': {
      return 'CEREBRAS_API_KEY';
    }
    case 'samba': {
      return 'SAMBA_API_KEY';
    }
    case 'together': {
      return 'TOGETHER_API_KEY';
    }
    default: {
      return undefined;
    }
  }
};
