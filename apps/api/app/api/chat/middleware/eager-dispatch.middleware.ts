import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { EagerToolDispatchHandler } from '#api/chat/eager-dispatch/eager-tool-dispatch.handler.js';

/** Returns cached `{@link ToolMessage}` / `{@link Command}` from `{@link EagerToolDispatchHandler}` or awaits the in-flight eager `invoke`. */
export const createEagerDispatchMiddleware = (handler: EagerToolDispatchHandler): AgentMiddleware =>
  createMiddleware({
    name: 'EagerDispatch',
    wrapToolCall: async (request, baseInvoke) => {
      const eagerEntry = handler.entries.get(request.toolCall.id ?? '');
      if (!eagerEntry) {
        return baseInvoke(request);
      }

      if (eagerEntry.result !== undefined) {
        return eagerEntry.result;
      }

      const outcome = await eagerEntry.invokePromise;
      if (outcome === undefined) {
        return baseInvoke(request);
      }

      return outcome;
    },
  });
