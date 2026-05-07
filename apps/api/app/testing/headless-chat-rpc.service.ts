import { Injectable } from '@nestjs/common';
import type {
  RpcSchemasRegistry,
  RpcInput,
  RpcResult,
  RpcCall,
  RpcExecutionError,
  RpcValidationError,
} from '@taucad/chat';
import type { RpcDispatcher } from '@taucad/chat/rpc';
import { ChatRpcService } from '#api/chat/chat-rpc.service.js';

/**
 * Lifecycle stages of a single RPC dispatch, fed to {@link RpcTimingObserver}.
 *
 * - `invoked`: the agent's tool runtime called `sendRpcRequest` (i.e. the
 *   API side has the finalized tool input and is about to dispatch).
 * - `dispatched`: the headless dispatcher began executing the local work
 *   (the analogue of "RPC arrived on the client" in production, where the
 *   browser receives the `rpc_request` Socket.IO event).
 * - `resolved`: the dispatcher returned the result back into the agent
 *   runtime — the moment the matching ToolMessage is materialised.
 */
export type RpcTimingStage = 'invoked' | 'dispatched' | 'resolved';

export type RpcTimingEvent = {
  stage: RpcTimingStage;
  toolCallId: string;
  rpcName: keyof RpcSchemasRegistry;
  /** `performance.now()` reading at the moment the event was recorded. */
  t: number;
};

export type RpcTimingObserver = (event: RpcTimingEvent) => void;

/**
 * Headless ChatRpcService that bypasses Socket.IO entirely.
 *
 * Instead of sending RPC requests over WebSocket to a browser client,
 * this service dispatches them directly to a local RpcDispatcher
 * backed by in-memory filesystem and runtime worker.
 *
 * Optionally accepts an {@link RpcTimingObserver} so tests can correlate the
 * agent-side dispatch timeline with the SSE chunk timeline. Each RPC call
 * fires `invoked` → `dispatched` → `resolved` events with monotonic
 * `performance.now()` timestamps; in headless mode the gap between
 * `invoked` and `dispatched` is sub-millisecond (no socket hop), so a
 * meaningful spread between the three is the regression signal that the
 * RPC is being serialised somewhere upstream.
 */
@Injectable()
export class HeadlessChatRpcService extends ChatRpcService {
  private dispatcher: RpcDispatcher | undefined;
  private timingObserver: RpcTimingObserver | undefined;

  public setDispatcher(dispatcher: RpcDispatcher): void {
    this.dispatcher = dispatcher;
  }

  public setTimingObserver(observer: RpcTimingObserver | undefined): void {
    this.timingObserver = observer;
  }

  public override async sendRpcRequest<T extends keyof RpcSchemasRegistry>(request: {
    chatId: string;
    toolCallId: string;
    rpcName: T;
    args: RpcInput<T>;
  }): Promise<RpcResult<T> | RpcExecutionError | RpcValidationError> {
    if (!this.dispatcher) {
      return {
        errorCode: 'NO_CONNECTION',
        message: 'HeadlessChatRpcService: dispatcher not set. Call setDispatcher() first.',
        rpcName: request.rpcName,
      };
    }

    const observer = this.timingObserver;
    const emit = (stage: RpcTimingStage): void => {
      observer?.({
        stage,
        toolCallId: request.toolCallId,
        rpcName: request.rpcName,
        t: performance.now(),
      });
    };

    emit('invoked');

    try {
      const call: RpcCall<T> = {
        rpcName: request.rpcName,
        args: request.args,
      };
      emit('dispatched');
      const result = await this.dispatcher.dispatch(call);
      emit('resolved');
      return result;
    } catch (error) {
      emit('resolved');
      return {
        errorCode: 'UNHANDLED_CLIENT_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error in headless RPC',
        rpcName: request.rpcName,
      };
    }
  }

  // No-ops for connection management (no Socket.IO in headless mode)
  public override registerConnection(): boolean {
    return true;
  }

  public override unregisterConnection(): void {
    // No-op
  }

  public override registerAbortSignal(): void {
    // No-op
  }
}
