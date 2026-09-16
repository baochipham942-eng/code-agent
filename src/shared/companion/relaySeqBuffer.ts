import { COMPANION_LIMITS as L } from '../constants/companion';
import type { CompanionRelayFrame } from '../contract/companionRelay';

/**
 * Deliver in seq order. Gaps are never skipped. Duplicates are ignored.
 * 住在 shared 而不是 host：手机 relay 客户端与 Host 侧 CompanionRelayClient 共用同一条
 * 重排语义（N-MOBILE-RELAY-PHONE），分家会各自漂。
 */
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
