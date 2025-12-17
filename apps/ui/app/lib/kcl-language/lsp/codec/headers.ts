/**
 * LSP message header utilities.
 * Handles Content-Length header encoding/decoding for JSON-RPC messages.
 */

export function addHeaders(message: string): string {
  return `Content-Length: ${message.length}\r\n\r\n${message}`;
}

/**
 * Parse all LSP messages from a raw buffer.
 * LSP messages are framed with "Content-Length: xxx\r\n\r\n{json}"
 * Multiple messages can be concatenated together.
 */
export function parseMessages(data: string): string[] {
  const messages: string[] = [];
  let remaining = data;

  while (remaining.length > 0) {
    // Find the Content-Length header
    const contentLengthMatch = remaining.match(/^Content-Length:\s*(\d+)\s*\r?\n\r?\n/);

    if (contentLengthMatch) {
      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const headerLength = contentLengthMatch[0].length;
      const messageEnd = headerLength + contentLength;

      if (remaining.length >= messageEnd) {
        // Extract the JSON message
        const jsonMessage = remaining.slice(headerLength, messageEnd);
        messages.push(jsonMessage);
        remaining = remaining.slice(messageEnd);
      } else {
        // Incomplete message - shouldn't happen in single writes but handle gracefully
        console.warn('[Headers] Incomplete LSP message, expected', contentLength, 'bytes');
        break;
      }
    } else {
      // No valid header found - try to parse as raw JSON (fallback)
      const trimmed = remaining.trim();
      if (trimmed.startsWith('{')) {
        messages.push(trimmed);
      }
      break;
    }
  }

  return messages;
}
