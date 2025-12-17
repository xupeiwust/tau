/**
 * A map that stores promises and resolves them when values are set.
 * Used for matching LSP responses to their requests by ID.
 */

type PromiseMapEntry<V> =
  | { status: 'pending'; resolve: (item: V) => void; promise: Promise<V> }
  | { status: 'resolved' };

export class PromiseMap<K, V> {
  private readonly map = new Map<K, PromiseMapEntry<V>>();

  public get(key: K): Promise<V> | undefined {
    const existingEntry = this.map.get(key);
    const entry = existingEntry ?? this.createEntry(key);

    if (entry.status === 'pending') {
      return entry.promise;
    }

    return undefined;
  }

  public set(key: K, value: V): this {
    const entry = this.createEntry(key, value);

    if (entry.status === 'pending') {
      this.map.set(key, { status: 'resolved' });
      entry.resolve(value);
    }

    return this;
  }

  public get size(): number {
    return this.map.size;
  }

  private createEntry(key: K, value?: V): PromiseMapEntry<V> {
    const existingEntry = this.map.get(key);
    if (existingEntry) {
      return existingEntry;
    }

    let resolve: (item: V) => void = () => {
      // Placeholder
    };

    const promise = new Promise<V>((_resolve) => {
      resolve = _resolve;
    });

    const entry: PromiseMapEntry<V> = {
      status: 'pending',
      resolve,
      promise,
    };

    if (value !== undefined) {
      entry.resolve(value);
    }

    this.map.set(key, entry);

    return entry;
  }
}
