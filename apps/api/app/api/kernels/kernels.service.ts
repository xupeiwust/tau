import { Buffer } from 'node:buffer';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { Models } from '@kittycad/lib';
import type { Environment } from '#config/environment.config.js';

type WebSocketResponse = Models['WebSocketResponse_type'];
type WebSocketRequest = Models['WebSocketRequest_type'];

/**
 * Type guard to check if the parsed message is a valid WebSocket response.
 * Validates the discriminated union structure.
 */
function isWebSocketResponse(data: unknown): data is WebSocketResponse {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const response = data as Record<string, unknown>;

  // Check for success response
  if (response['success'] === true) {
    const { resp } = response;

    return (
      typeof resp === 'object' &&
      resp !== null &&
      'type' in resp &&
      typeof (resp as Record<string, unknown>)['type'] === 'string'
    );
  }

  // Check for failure response
  if (response['success'] === false) {
    return Array.isArray(response['errors']);
  }

  return false;
}

/**
 * Type guard to check if the parsed message is a WebSocket request with headers type.
 * Used to intercept client authentication attempts.
 */
function isHeadersRequest(data: unknown): data is Extract<WebSocketRequest, { type: 'headers' }> {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>)['type'] === 'headers';
}

/**
 * RFC 6455 close codes that are reserved and must not be sent in a close frame.
 * - 1005: No Status Rcvd - must not be sent
 * - 1006: Abnormal Closure - must not be sent
 * - 1015: TLS Handshake - must not be sent
 */
const forbiddenCloseCodes = new Set([1005, 1006, 1015]);

/**
 * Validates a WebSocket close code according to RFC 6455.
 * Returns the original code if valid, otherwise returns 1011 (Internal Error).
 *
 * Valid codes: 1000-4999, excluding 1005, 1006, 1015
 * @param code - The close code to validate (may be undefined)
 * @returns A valid close code safe to send in a WebSocket close frame
 */
function getSafeCloseCode(code: number | undefined): number {
  // Missing or out of valid range (1000-4999)
  if (code === undefined || code < 1000 || code > 4999) {
    return 1011;
  }

  // Forbidden/reserved codes that must not be sent
  if (forbiddenCloseCodes.has(code)) {
    return 1011;
  }

  return code;
}

@Injectable()
export class KernelsService {
  private readonly logger = new Logger(KernelsService.name);
  private readonly zooApiKey: string;
  private readonly zooWebsocketUrl: string;

  public constructor(private readonly configService: ConfigService<Environment, true>) {
    this.zooApiKey = this.configService.get('ZOO_API_KEY', { infer: true });
    this.zooWebsocketUrl = this.configService.get('ZOO_WEBSOCKET_URL', { infer: true });
  }

  /**
   * Create a WebSocket connection to the Zoo API and handle bidirectional proxying.
   * @param clientSocket - The client's WebSocket connection
   * @param queryParameters - Query parameters to forward to Zoo API
   */
  public createZooProxy(clientSocket: WebSocket, queryParameters: URLSearchParams): void {
    // Build the Zoo API WebSocket URL with query parameters
    const zooUrl = new URL('/ws/modeling/commands', this.zooWebsocketUrl);
    for (const [key, value] of queryParameters.entries()) {
      zooUrl.searchParams.set(key, value);
    }

    this.logger.debug(`Connecting to Zoo API: ${zooUrl.toString()}`);

    // Create connection to Zoo API
    const zooSocket = new WebSocket(zooUrl);
    zooSocket.binaryType = 'arraybuffer';

    // Use a single state object to prevent race conditions when both sockets close simultaneously
    const connectionState = {
      isZooAuthenticated: false,
      clientClosed: false,
      zooClosed: false,
      isCleaningUp: false,
    };

    /**
     * Attempts to claim exclusive cleanup responsibility.
     * Prevents double cleanup when both sockets close simultaneously.
     * @returns true if this caller should perform cleanup, false if another caller already claimed it
     */
    const tryClaimCleanup = (): boolean => {
      if (connectionState.isCleaningUp) {
        return false;
      }

      connectionState.isCleaningUp = true;

      return true;
    };

    // Handle Zoo socket open - send authentication
    zooSocket.addEventListener('open', () => {
      this.logger.debug('Zoo WebSocket connected, sending authentication');

      // Send authentication headers as expected by Zoo API
      const authMessage = JSON.stringify({
        type: 'headers',
        headers: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- Zoo API expects this format
          Authorization: `Bearer ${this.zooApiKey}`,
        },
      });
      zooSocket.send(authMessage);
    });

    // Handle messages from Zoo -> forward to client
    zooSocket.addEventListener('message', (event) => {
      if (connectionState.clientClosed) {
        return;
      }

      // Check if this is the authentication success response
      if (!connectionState.isZooAuthenticated && typeof event.data === 'string') {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (isWebSocketResponse(parsed) && parsed.success && parsed.resp.type === 'modeling_session_data') {
            connectionState.isZooAuthenticated = true;
            this.logger.debug('Zoo authentication successful');
          }
        } catch (error) {
          // Not JSON, continue forwarding - this is expected for non-JSON messages
          this.logger.verbose('Received non-JSON message from Zoo during auth check:', error);
        }
      }

      // Forward message to client
      try {
        if (clientSocket.readyState === WebSocket.OPEN) {
          if (event.data instanceof ArrayBuffer) {
            clientSocket.send(Buffer.from(event.data));
          } else {
            clientSocket.send(event.data);
          }
        }
      } catch (error) {
        this.logger.error('Error forwarding message to client:', error);
      }
    });

    // Handle messages from client -> forward to Zoo
    clientSocket.addEventListener('message', (event) => {
      if (connectionState.zooClosed) {
        return;
      }

      // Intercept and drop 'headers' messages from client - proxy handles authentication
      if (typeof event.data === 'string') {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (isHeadersRequest(parsed)) {
            this.logger.debug('Dropping client headers message - proxy handles authentication');
            return;
          }
        } catch (error) {
          // Not JSON, continue forwarding - this is expected for non-JSON messages
          this.logger.verbose('Received non-JSON message from client:', error);
        }
      }

      try {
        if (zooSocket.readyState === WebSocket.OPEN) {
          // Forward the message as-is (binary or text)
          zooSocket.send(event.data);
        }
      } catch (error) {
        this.logger.error('Error forwarding message to Zoo:', error);
      }
    });

    // Handle Zoo socket close
    zooSocket.addEventListener('close', (event) => {
      connectionState.zooClosed = true;
      this.logger.debug(`Zoo WebSocket closed: code=${event.code}, reason=${event.reason}`);

      if (tryClaimCleanup() && clientSocket.readyState === WebSocket.OPEN) {
        // Forward the close code if valid per RFC 6455, otherwise use 1011 (Internal Error)
        const closeCode = getSafeCloseCode(event.code);
        clientSocket.close(closeCode, event.reason || 'Upstream connection closed');
      }
    });

    // Handle Zoo socket error
    zooSocket.addEventListener('error', (event) => {
      this.logger.error('Zoo WebSocket error:', event);

      if (tryClaimCleanup() && clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close(1011, 'Upstream connection error');
      }
    });

    // Handle client socket close
    clientSocket.addEventListener('close', () => {
      connectionState.clientClosed = true;
      this.logger.debug('Client WebSocket closed');

      if (tryClaimCleanup() && zooSocket.readyState === WebSocket.OPEN) {
        zooSocket.close();
      }
    });

    // Handle client socket error
    clientSocket.addEventListener('error', (event) => {
      this.logger.error('Client WebSocket error:', event);

      if (tryClaimCleanup() && zooSocket.readyState === WebSocket.OPEN) {
        zooSocket.close();
      }
    });
  }
}
