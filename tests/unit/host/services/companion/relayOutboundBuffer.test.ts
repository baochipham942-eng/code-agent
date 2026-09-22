import { describe, expect, it } from 'vitest';
import { RelayOutboundBuffer, RelaySeqBuffer } from '../../../../../src/host/services/companion/companionRelayBuffer';
import type { CompanionRelayFrame } from '../../../../../src/shared/contract/companionRelay';

function frame(seq: number, issuedAt = 1_000): CompanionRelayFrame {
  return {
    v: 1, kind: 'forward',
    envelope: { routeToken: 'route-token-aaaaaa', deviceRef: 'phone-1', seq, ttlMs: 60_000, issuedAt },
    ciphertext: 'aa',
  };
}

describe('relay outbound buffer', () => {
  it('queues until the frame/byte cap then drops', () => {
    const buffer = new RelayOutboundBuffer(2, 10_000);
    expect(buffer.enqueue(frame(0))).toBe('queued');
    expect(buffer.enqueue(frame(1))).toBe('queued');
    expect(buffer.enqueue(frame(2))).toBe('dropped');
    expect(buffer.size).toBe(2);
    expect(buffer.dropped).toBe(1);
    expect(buffer.drain().map(item => item.envelope.seq)).toEqual([0, 1]);
    expect(buffer.size).toBe(0);
  });

  it('drops when the byte cap is exceeded', () => {
    const sample = Buffer.byteLength(JSON.stringify(frame(0)));
    const buffer = new RelayOutboundBuffer(8, sample + 8);
    expect(buffer.enqueue(frame(0))).toBe('queued');
    expect(buffer.enqueue(frame(1))).toBe('dropped');
    expect(buffer.dropped).toBe(1);
  });
});

describe('relay seq buffer', () => {
  it('releases in order after a reorder and never skips a gap', () => {
    const buffer = new RelaySeqBuffer(8);
    expect(buffer.push(frame(0), 1_000).map(item => item.envelope.seq)).toEqual([0]);
    expect(buffer.push(frame(2), 1_000)).toEqual([]);
    expect(buffer.push(frame(1), 1_000).map(item => item.envelope.seq)).toEqual([1, 2]);
    expect(buffer.push(frame(4), 1_000)).toEqual([]);
    expect(buffer.push(frame(3), 1_000).map(item => item.envelope.seq)).toEqual([3, 4]);
  });

  it('ignores duplicates and expired held frames', () => {
    const buffer = new RelaySeqBuffer(8);
    expect(buffer.push(frame(0), 1_000)).toHaveLength(1);
    expect(buffer.push(frame(0), 1_000)).toEqual([]);
    expect(buffer.push(frame(2, 1_000), 1_000)).toEqual([]);
    expect(buffer.push(frame(3, 1_000), 70_000)).toEqual([]);
  });
});
