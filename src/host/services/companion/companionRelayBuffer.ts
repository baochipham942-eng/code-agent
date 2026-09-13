import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionRelayFrame } from '../../../shared/contract/companionRelay';

export type RelayEnqueueResult = 'queued' | 'dropped';

/** Bounded outbound queue. Disconnect must not grow without limit. */
export class RelayOutboundBuffer {
  private readonly frames: CompanionRelayFrame[] = [];
  private bytes = 0;
  dropped = 0;
  constructor(
    private readonly maxFrames: number = L.relayMaxBufferedFrames,
    private readonly maxBytes: number = L.relayMaxBufferedBytes,
  ) {}

  get size(): number { return this.frames.length; }

  enqueue(frame: CompanionRelayFrame): RelayEnqueueResult {
    const size = Buffer.byteLength(JSON.stringify(frame));
    if (this.frames.length >= this.maxFrames || this.bytes + size > this.maxBytes) {
      this.dropped += 1;
      return 'dropped';
    }
    this.frames.push(frame);
    this.bytes += size;
    return 'queued';
  }

  drain(): CompanionRelayFrame[] {
    const out = this.frames.splice(0);
    this.bytes = 0;
    return out;
  }

  clear(): void {
    this.frames.length = 0;
    this.bytes = 0;
  }
}

/** Deliver in seq order. Gaps are never skipped. Duplicates are ignored. */
export class RelaySeqBuffer {
  private expected = 0;
  private readonly held = new Map<number, CompanionRelayFrame>();
  constructor(private readonly maxHeld: number = L.relaySeqHold) {}

  reset(): void {
    this.expected = 0;
    this.held.clear();
  }

  push(frame: CompanionRelayFrame, now: number): CompanionRelayFrame[] {
    for (const [seq, held] of this.held) {
      if (held.envelope.issuedAt + held.envelope.ttlMs <= now) this.held.delete(seq);
    }
    const seq = frame.envelope.seq;
    if (seq < this.expected) return [];
    if (seq === this.expected) {
      const ready = [frame];
      this.expected += 1;
      while (this.held.has(this.expected)) {
        const next = this.held.get(this.expected);
        if (!next) break;
        ready.push(next);
        this.held.delete(this.expected);
        this.expected += 1;
      }
      return ready;
    }
    if (this.held.size >= this.maxHeld || this.held.has(seq)) return [];
    this.held.set(seq, frame);
    return [];
  }
}
