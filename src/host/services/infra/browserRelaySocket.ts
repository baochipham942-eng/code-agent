// N-MAXLINES-MINEFIELD-2-FU1-S6 move-only extraction: self-contained WebSocket
// frame reader/writer for the browser relay extension connection, moved
// byte-identical from browserRelayService.ts (no service access).
import type net from 'net';

export class BrowserRelaySocket {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly onMessage: (message: unknown) => void,
    private readonly onClose: () => void,
  ) {
    socket.on('data', (chunk) => this.handleData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    socket.once('close', () => this.handleClose());
    socket.once('error', () => this.handleClose());
  }

  sendJson(value: unknown): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  close(): void {
    if (this.closed) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.handleClose();
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) === 0x80;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const length64 = this.buffer.readBigUInt64BE(offset);
        if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close();
          return;
        }
        payloadLength = Number(length64);
        offset += 8;
      }

      const maskOffset = masked ? 4 : 0;
      const frameLength = offset + maskOffset + payloadLength;
      if (this.buffer.length < frameLength) return;

      let payload = this.buffer.subarray(offset + maskOffset, frameLength);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(frameLength);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode !== 0x1) {
        continue;
      }

      try {
        this.onMessage(JSON.parse(payload.toString('utf8')));
      } catch {
        // Ignore malformed extension messages; auth is already enforced at upgrade.
      }
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}
