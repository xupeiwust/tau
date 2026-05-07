import { errorCategory, errorCategories } from '@taucad/types/constants';
import type { ErrorCategory, ChatError } from '@taucad/types';
import { errorCategoryTitles } from '@taucad/chat/utils';

/**
 * Client-side transport failure (request never reaches the API as structured JSON).
 * Mirrors AI SDK `Chat.makeRequest` disconnect classification in `ai` package
 * (`ai/src/ui/chat.ts`, TypeError branch: `fetch` / `network` substrings on the message).
 */
function isTransportError(error: Error): boolean {
  if (error instanceof TypeError) {
    const lowered = error.message.toLowerCase();
    if (lowered.includes('fetch') || lowered.includes('network')) {
      return true;
    }
  }

  const lowered = error.message.toLowerCase();
  return lowered.includes('load failed') || error.message.includes('net::ERR_');
}

/**
 * Parses a ChatError from JSON.
 * The API always sends errors in ChatError format, so we just parse and validate.
 */
function tryParseChatError(message: string): ChatError | undefined {
  if (!message.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;

    // Validate required fields
    if (
      typeof parsed['category'] === 'string' &&
      typeof parsed['title'] === 'string' &&
      typeof parsed['message'] === 'string'
    ) {
      // Validate category against known values, fallback to generic if unknown
      const parsedCategory = parsed['category'];
      const category: ErrorCategory = errorCategories.includes(parsedCategory as ErrorCategory)
        ? (parsedCategory as ErrorCategory)
        : errorCategory.generic;

      return {
        category,
        title: parsed['title'],
        message: parsed['message'],
        code: typeof parsed['code'] === 'string' ? parsed['code'] : undefined,
        httpStatus: typeof parsed['httpStatus'] === 'number' ? parsed['httpStatus'] : undefined,
        raw: typeof parsed['raw'] === 'string' ? parsed['raw'] : undefined,
        requestId: typeof parsed['requestId'] === 'string' ? parsed['requestId'] : undefined,
        helpUrl: typeof parsed['helpUrl'] === 'string' ? parsed['helpUrl'] : undefined,
      };
    }
  } catch {
    // Not valid JSON
  }

  return undefined;
}

/**
 * Parses an Error object into a ChatError for persistence.
 * This is used to store errors in the chat entity so they survive page reloads.
 *
 * The API always sends errors in ChatError format, so this function just:
 * 1. Handles client-side network errors (which never reach the API)
 * 2. Parses the structured ChatError from the API response
 * 3. Falls back to a generic error for unexpected formats
 */
export function parseErrorForPersistence(error: Error): ChatError {
  // Handle client-side network errors (these never reach the API)
  if (isTransportError(error)) {
    return {
      category: errorCategory.network,
      title: errorCategoryTitles[errorCategory.network],
      message: 'Unable to connect to the server. Please check your internet connection.',
      raw: error.message,
    };
  }

  // Parse structured ChatError from API
  const parsed = tryParseChatError(error.message);
  if (parsed) {
    return parsed;
  }

  // Fallback for unexpected formats
  return {
    category: errorCategory.generic,
    title: errorCategoryTitles[errorCategory.generic],
    message: error.message,
    raw: error.message,
  };
}
