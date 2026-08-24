export interface ExclusiveExecutor {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

/// Serializes signer operations inside one modular-monolith process.
export class InMemoryExclusiveExecutor implements ExclusiveExecutor {
  #tail: Promise<void> = Promise.resolve();

  public async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
