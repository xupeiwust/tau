/**
 * Callback sinks that expose `writer` threading for LangGraph `custom` stream payloads.
 */

export type WriterAttachableCallbackHandler = {
  setWriter(writer: ((chunk: unknown) => void) | undefined): void;
};
