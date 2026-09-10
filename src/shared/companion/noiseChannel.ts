import Noise, { type KeyPair } from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { COMPANION_LIMITS as L } from '../constants/companion';
import { fromHex, toHex, LAN_PROLOGUE } from './lanProtocol';

export function createIdentity(): KeyPair { return new Noise('IK', true).s; }
export function createHandshake(initiator: boolean, identity: KeyPair, inviteId?: string, psk?: string, hostKey?: string): Noise {
  const noise = new Noise(inviteId ? 'XXpsk0' : 'IK', initiator, identity, psk ? { psk: fromHex(psk, 32) } : undefined);
  noise.initialise(new TextEncoder().encode(`${LAN_PROLOGUE}/${inviteId ?? 'resume'}`), hostKey ? fromHex(hostKey, 32) : undefined);
  return noise;
}

// ponytail: package.json overrides noise-handshake's `sodium-universal` to the pure-JS
// `sodium-javascript@0.8.0` (JSON takes no comments, so the note lives here, next to the
// crypto it governs). This is a deliberate downgrade, not an equivalent swap: the pure-JS
// primitives are NOT constant-time, so this channel must not be treated as hardened against
// a local timing side channel. It buys a dependency with no native build step, which is what
// keeps the mobile bundle and CI installable. Upgrade path: drop the override and ship
// prebuilt sodium-native binaries for every target once the mobile build can carry them.

/** Ordered duplex records. Any ambiguity retires the channel; retry with a new handshake. */
export class NoiseChannel {
  private readonly tx: Cipher;
  private readonly rx: Cipher;
  private sent = 0;
  private received = 0;
  private closed = false;
  constructor(noise: Noise) {
    if (!noise.complete) throw new Error('COMPANION_HANDSHAKE_INCOMPLETE');
    this.tx = new Cipher(noise.tx); this.rx = new Cipher(noise.rx);
  }
  seal(value: unknown): string[] {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const total = Math.ceil(bytes.length / L.maxPayloadBytes);
      if (this.closed || total < 1 || total > L.maxMessageRecords || this.sent + total > L.maxFrames) throw new Error('COMPANION_CHANNEL_LIMIT');
      return Array.from({ length: total }, (_, index) => {
        const payload = bytes.subarray(index * L.maxPayloadBytes, (index + 1) * L.maxPayloadBytes);
        const record = new Uint8Array(payload.length + 8);
        const header = new DataView(record.buffer);
        header.setUint32(0, index); header.setUint32(4, total); record.set(payload, 8);
        const frame = toHex(this.tx.encrypt(record)); this.sent++; return frame;
      });
    } catch (error) { this.close(); throw error; }
  }
  open(frame: unknown): unknown {
    try {
      if (this.closed || !Array.isArray(frame) || frame.length < 1 || frame.length > L.maxMessageRecords || this.received + frame.length > L.maxFrames) throw new Error('COMPANION_CHANNEL_LIMIT');
      const chunks = frame.map((part: unknown, index) => {
        const record = this.rx.decrypt(fromHex(part));
        const header = new DataView(record.buffer, record.byteOffset, record.byteLength);
        if (header.getUint32(0) !== index || header.getUint32(4) !== frame.length || record.length > L.maxPayloadBytes + 8) throw new Error('COMPANION_INVALID_RECORD');
        this.received++; return record.subarray(8);
      });
      const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch (error) { this.close(); throw error; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.tx._clear(); this.rx._clear();
  }
}
