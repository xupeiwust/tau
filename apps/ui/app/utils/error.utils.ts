import { errorCategory, errorCategories } from '@taucad/types';
import type { ErrorCategory, ChatError } from '@taucad/types';

/**
 * Checks if error is a client-side network error (never reaches the API).
 */
function isNetworkError(message: string): boolean {
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('net::ERR_') ||
    message.includes('Load failed')
  );
}

/**
 * Parses the JSON error from the API.
 */
function tryParseApiError(message: string): ChatError | undefined {
  if (!message.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;

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
 * Parses an Error object into a NormalizedChatError for persistence.
 * This is used to store errors in the chat entity so they survive page reloads.
 */
export function parseErrorForPersistence(error: Error): ChatError {
  // Handle client-side network errors (these never reach the API)
  if (isNetworkError(error.message)) {
    return {
      category: errorCategory.network,
      title: 'Connection Error',
      message: 'Unable to connect to the server. Please check your internet connection.',
      raw: error.message,
    };
  }

  // Parse structured error from API
  const parsed = tryParseApiError(error.message);
  if (parsed) {
    return parsed;
  }

  // Fallback for unexpected formats
  return {
    category: errorCategory.generic,
    title: 'Error',
    message: error.message,
    raw: error.message,
  };
}
