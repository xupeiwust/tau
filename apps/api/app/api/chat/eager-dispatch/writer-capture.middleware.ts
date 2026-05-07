import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { WriterAttachableCallbackHandler } from '#api/chat/eager-dispatch/writer-capable-handler.js';

/** Captures LangGraph `config.writer` so callback handlers emit `custom`-stream payloads deterministically — `getWriter()` ALS context does not reliably propagate across `handleLLMNewToken`. */
export const createWriterCaptureMiddleware = (handler: WriterAttachableCallbackHandler): AgentMiddleware =>
  createMiddleware({
    name: 'EagerWriterCapture',
    wrapModelCall: async (request, baseHandler) => {
      handler.setWriter(request.runtime.writer as ((chunk: unknown) => void) | undefined);
      return baseHandler(request);
    },
  });
