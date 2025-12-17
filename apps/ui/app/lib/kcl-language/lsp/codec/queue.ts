/**
 * Async queue implementation for LSP message handling.
 */

const isDebugEnabled = true;
function log(...arguments_: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- debug flag
  if (isDebugEnabled) {
    console.log('[Queue]', ...arguments_);
  }
}

export class Queue<T> {
  private readonly promises: Array<Promise<T>> = [];
  private readonly resolvers: Array<(item: T) => void> = [];
  private closed = false;

  public enqueue(item: T): void {
    log('enqueue() called, closed:', this.closed, 'resolvers:', this.resolvers.length);
    if (!this.closed) {
      if (this.resolvers.length === 0) {
        this.addPromise();
      }

      const resolve = this.resolvers.shift();
      if (resolve) {
        log('Resolving with item');
        resolve(item);
      }
    }
  }

  public async dequeue(): Promise<T> {
    log('dequeue() called, promises:', this.promises.length);
    if (this.promises.length === 0) {
      this.addPromise();
    }

    const item = this.promises.shift();
    if (!item) {
      throw new Error('Queue is unexpectedly empty');
    }

    log('dequeue() awaiting item...');
    const result = await item;
    log('dequeue() got item');
    return result;
  }

  public isEmpty(): boolean {
    return this.promises.length === 0;
  }

  public isBlocked(): boolean {
    return this.resolvers.length > 0;
  }

  public get length(): number {
    return this.promises.length - this.resolvers.length;
  }

  public async next(): Promise<IteratorResult<T, never>> {
    log('next() called');
    const value = await this.dequeue();
    log('next() returning value');
    return { done: false, value };
  }

  public async return_(): Promise<IteratorResult<T, never>> {
    log('return_() called');
    return new Promise(() => {
      // Empty - never resolves
    });
  }

  public async throw_(error: Error): Promise<IteratorResult<T, never>> {
    log('throw_() called');
    throw error;
  }

  public [Symbol.asyncIterator](): AsyncIterator<T, never, void> {
    log('[Symbol.asyncIterator] called');
    return {
      next: async () => this.next(),
    };
  }

  public close(): void {
    log('close() called');
    this.closed = true;
  }

  private addPromise(): void {
    log('addPromise() called');
    this.promises.push(
      new Promise((resolve) => {
        this.resolvers.push(resolve);
      }),
    );
  }
}
