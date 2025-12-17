/**
 * Web Worker that hosts the KCL WASM LSP server.
 *
 * This worker:
 * 1. Loads the WASM module
 * 2. Creates the LSP server configuration
 * 3. Runs the KCL LSP server
 * 4. Routes messages between the main thread and the WASM LSP
 */

import type { JSONRPCRequest, JSONRPCResponse } from 'json-rpc-2.0';
import init, { LspServerConfig, lsp_run_kcl } from '@taucad/kcl-wasm-lib';
import wasmPath from '@taucad/kcl-wasm-lib/kcl.wasm?url';
import { Queue } from '#lib/kcl-language/lsp/codec/queue.js';
import { StreamDemuxer } from '#lib/kcl-language/lsp/codec/stream-demuxer.js';
import { encodeMessage, decodeMessage } from '#lib/kcl-language/lsp/codec/utils.js';
import { LspWorkerEventType } from '#lib/kcl-language/lsp/kcl-lsp-types.js';
import type { KclLspWorkerOptions, LspWorkerEvent } from '#lib/kcl-language/lsp/kcl-lsp-types.js';

const isDebugEnabled = true;
function log(...arguments_: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- debug flag
  if (isDebugEnabled) {
    console.log('[KCL LSP Worker]', ...arguments_);
  }
}

/**
 * Mock FileSystemManager for the LSP.
 * The LSP receives document content via textDocument/didOpen and didChange,
 * so it doesn't need actual filesystem access for basic language features.
 */
class MockFileSystemManager {
  public async readFile(_path: string): Promise<Uint8Array> {
    log('FileSystem.readFile called:', _path);
    return new Uint8Array();
  }

  public async exists(_path: string): Promise<boolean> {
    log('FileSystem.exists called:', _path);
    return false;
  }

  public async getAllFiles(_path: string): Promise<string[]> {
    log('FileSystem.getAllFiles called:', _path);
    return [];
  }
}

const intoServer = new Queue<Uint8Array>();
const fromServer = new StreamDemuxer();
let isWasmReady = false;
let wasmReadyPromise: Promise<void> | undefined;
let resolveWasmReady: () => void;

async function initializeWasm(wasmUrl: string): Promise<void> {
  log('Fetching WASM from:', wasmUrl);
  const input = await fetch(wasmUrl);
  log('WASM fetch complete, getting buffer...');
  const buffer = await input.arrayBuffer();
  log('Initializing WASM module...');
  await init(buffer);
  log('WASM module initialized successfully');
}

async function runKclLsp(token: string, apiBaseUrl: string): Promise<void> {
  try {
    log('Creating LSP server configuration...');
    const fileSystemManager = new MockFileSystemManager();
    const config = new LspServerConfig(intoServer, fromServer, fileSystemManager);
    log('Starting KCL LSP server (token:', token ? 'provided' : 'empty', ', baseUrl:', apiBaseUrl || 'empty', ')');

    // Signal that WASM is ready before starting the server
    isWasmReady = true;
    resolveWasmReady();
    log('WASM ready signal sent');

    await lsp_run_kcl(config, token, apiBaseUrl);
    log('LSP server exited normally');
  } catch (error: unknown) {
    console.error('[KCL LSP Worker] LSP server error:', error);
    // Even on error, mark as ready so pending requests don't hang forever
    isWasmReady = true;
    resolveWasmReady();
  }
}

async function handleInitEvent(eventData: KclLspWorkerOptions): Promise<void> {
  const { wasmUrl, token, apiBaseUrl } = eventData;
  const actualWasmUrl = wasmUrl || wasmPath;
  log('Init event received, wasmUrl:', actualWasmUrl);

  // Create the ready promise
  wasmReadyPromise = new Promise((resolve) => {
    resolveWasmReady = resolve;
  });

  try {
    await initializeWasm(actualWasmUrl);
    log('WASM module loaded, starting LSP...');
    // Don't await - let it run in background
    void runKclLsp(token, apiBaseUrl);
    // Wait for the LSP to be ready before processing more messages
    await wasmReadyPromise;
    log('LSP initialization complete');
  } catch (error: unknown) {
    console.error('[KCL LSP Worker] Failed to initialize WASM:', error);
    isWasmReady = true;
    resolveWasmReady();
  }
}

async function handleCallEvent(data: Uint8Array): Promise<void> {
  const json = decodeMessage<JSONRPCRequest>(data);
  log('Call event received:', json.method, 'id:', json.id);

  // Wait for WASM to be ready
  if (!isWasmReady && wasmReadyPromise) {
    log('Waiting for WASM to be ready...');
    await wasmReadyPromise;
    log('WASM is ready, processing request');
  }

  // Enqueue the message for the WASM LSP to process
  intoServer.enqueue(data);
  log('Message enqueued for LSP');

  // If this is a request (has an ID), wait for the response
  if (json.id !== null && json.id !== undefined) {
    log('Waiting for response to request id:', json.id);
    const responsePromise = fromServer.responses.get(json.id);
    if (responsePromise) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vscode-jsonrpc types
        const response = await responsePromise;
        log('Got response for id:', json.id, response);
        const encoded = encodeMessage(response as JSONRPCResponse);
        globalThis.postMessage(encoded);
        log('Response sent to client');
      } catch (error: unknown) {
        console.error('[KCL LSP Worker] Error getting response:', error);
      }
    } else {
      log('No response promise created for id:', json.id);
    }
  }
}

function handleMessage(event: MessageEvent): void {
  const { eventType, eventData } = event.data as LspWorkerEvent;
  log('Message received, type:', eventType);

  switch (eventType) {
    case LspWorkerEventType.Init: {
      void handleInitEvent(eventData as KclLspWorkerOptions);
      break;
    }

    case LspWorkerEventType.Call: {
      void handleCallEvent(eventData as Uint8Array);
      break;
    }

    default: {
      console.error('[KCL LSP Worker] Unknown event type:', eventType);
    }
  }
}

globalThis.addEventListener('message', handleMessage);

async function forwardRequests(): Promise<void> {
  log('Starting request forwarder...');
  for await (const request of fromServer.requests) {
    log('Forwarding request from server:', request);
    const encoded = encodeMessage(request as JSONRPCRequest);
    globalThis.postMessage(encoded);
  }
}

async function forwardNotifications(): Promise<void> {
  log('Starting notification forwarder...');
  for await (const notification of fromServer.notifications) {
    log('Forwarding notification from server:', notification);
    const encoded = encodeMessage(notification as JSONRPCRequest);
    globalThis.postMessage(encoded);
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- worker context
void forwardRequests();
// eslint-disable-next-line unicorn/prefer-top-level-await -- worker context
void forwardNotifications();

log('Worker initialized, waiting for messages...');
