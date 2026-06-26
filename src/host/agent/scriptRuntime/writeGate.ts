interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

export interface WriteGate {
  acquire(signal?: AbortSignal): Promise<() => void>;
  stats(): { inFlight: number; queued: number };
}

export class SerialWriteGate implements WriteGate {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('write agent aborted before admission'));
        return;
      }

      const waiter: Waiter = { resolve, reject, settled: false };
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (waiter.settled) return;
            const idx = this.waiters.indexOf(waiter);
            if (idx >= 0) {
              this.waiters.splice(idx, 1);
              waiter.settled = true;
              reject(new Error('write agent aborted while queued'));
            }
          },
          { once: true },
        );
      }

      this.waiters.push(waiter);
      this.pump();
    });
  }

  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length };
  }

  private pump(): void {
    if (this.inFlight > 0) return;
    const waiter = this.waiters.shift();
    if (!waiter || waiter.settled) return;

    waiter.settled = true;
    this.inFlight = 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.inFlight = 0;
      this.pump();
    });
  }
}
