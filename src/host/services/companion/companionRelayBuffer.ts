import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionRelayFrame } from '../../../shared/contract/companionRelay';

export { RelaySeqBuffer } from '../../../shared/companion/relaySeqBuffer';

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
