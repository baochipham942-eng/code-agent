import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { URL } from 'url';
import type { ManagedBrowserExternalBridgeState } from '../../../shared/contract/desktop';
import { app, broadcastToRenderer } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import { createLogger } from './logger';

const DEFAULT_RELAY_PORT = 23001;
const COMMAND_TIMEOUT_MS = 30_000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type RelayStatus = ManagedBrowserExternalBridgeState['status'];

interface RelayStatusMessage {
  type?: string;
  attachedTabs?: unknown;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class BrowserRelaySocket {
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

export class BrowserRelayService implements Disposable {
  private readonly logger = createLogger('BrowserRelayService');
  private server: http.Server | null = null;
  private socket: BrowserRelaySocket | null = null;
  private pending = new Map<string, PendingCommand>();
  private token = crypto.randomBytes(24).toString('base64url');
  private port: number | null = null;
  private status: RelayStatus = 'stopped';
  private lastError: string | null = null;
  private lastConnectedAtMs: number | null = null;
  private attachedTabs: number[] = [];

  async ensureStarted(port = DEFAULT_RELAY_PORT): Promise<ManagedBrowserExternalBridgeState> {
    if (this.server && this.port) {
      return this.getState();
    }

    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket as net.Socket));
    this.server.once('error', (error) => {
      this.status = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.broadcastState();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server?.once('error', onError);
      this.server?.once('listening', onListening);
      this.server?.listen(port, '127.0.0.1');
    }).catch(async (error) => {
      await this.stop();
      if (port === DEFAULT_RELAY_PORT) {
        return this.ensureStarted(0).then(() => undefined);
      }
      throw error;
    });

    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    this.status = 'listening';
    this.lastError = null;
    this.broadcastState();
    return this.getState();
  }

  async stop(): Promise<ManagedBrowserExternalBridgeState> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser relay stopped.'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.attachedTabs = [];

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      }).catch(() => undefined);
    }

    this.server = null;
    this.port = null;
    this.status = 'stopped';
    this.broadcastState();
    return this.getState();
  }

  getState(): ManagedBrowserExternalBridgeState {
    const tokenHint = this.token.length > 8
      ? `${this.token.slice(0, 4)}...${this.token.slice(-4)}`
      : 'configured';
    return {
      enabled: this.status !== 'unsupported',
      status: this.status,
      requiresExplicitAuthorization: true,
      reason: this.getReason(),
      port: this.port,
      authToken: this.status === 'stopped' ? null : this.token,
      tokenHint,
      extensionPath: this.resolveExtensionPath(),
      connectedTabCount: this.status === 'connected' ? 1 : 0,
      attachedTabCount: this.attachedTabs.length,
      lastConnectedAtMs: this.lastConnectedAtMs,
      lastError: this.lastError,
    };
  }

  async listTabs(): Promise<unknown> {
    return this.sendCommand('tabs.list', {});
  }

  async createTab(url: string): Promise<unknown> {
    return this.sendCommand('tabs.create', { url, active: true });
  }

  async navigateTab(tabId: number, url: string): Promise<unknown> {
    return this.sendCommand('tabs.navigate', { tabId, url });
  }

  async attachTab(tabId: number): Promise<unknown> {
    return this.sendCommand('debugger.attach', { tabId });
  }

  async detachTab(tabId: number): Promise<unknown> {
    return this.sendCommand('debugger.detach', { tabId });
  }

  async screenshotTab(
    tabId: number,
    options?: { format?: string; quality?: number },
  ): Promise<unknown> {
    return this.sendCommand('tabs.screenshot', {
      tabId,
      format: options?.format || 'jpeg',
      quality: options?.quality || 80,
    });
  }

  async sendCdp(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.sendCommand('cdp.send', { tabId, method, params });
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private async sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    if (!this.socket || this.status !== 'connected') {
      throw new Error('Browser relay extension is not connected.');
    }

    const id = `relay_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const payload = { id, method, params };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser relay command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.sendJson(payload);
    });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port || DEFAULT_RELAY_PORT}`);
    if (req.method === 'GET' && requestUrl.pathname === '/api/browser-relay/config') {
      this.writeJson(res, {
        port: this.port,
        token: this.token,
        status: this.status,
      });
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/browser-relay/status') {
      this.writeJson(res, this.getState());
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port || DEFAULT_RELAY_PORT}`);
    const token = requestUrl.searchParams.get('token') || '';
    if (requestUrl.pathname !== '/ws/browser-relay' || token !== this.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));

    this.socket?.close();
    this.socket = new BrowserRelaySocket(
      socket,
      (message) => this.handleRelayMessage(message),
      () => this.handleRelayClosed(),
    );
    this.status = 'connected';
    this.lastConnectedAtMs = Date.now();
    this.lastError = null;
    this.broadcastState();
  }

  private handleRelayMessage(message: unknown): void {
    const record = message && typeof message === 'object' ? message as Record<string, unknown> : null;
    if (!record) return;

    if (record.type === 'status') {
      const status = message as RelayStatusMessage;
      this.attachedTabs = Array.isArray(status.attachedTabs)
        ? status.attachedTabs.filter((value): value is number => typeof value === 'number')
        : [];
      this.broadcastState();
      return;
    }

    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.error && typeof record.error === 'object') {
      const errorRecord = record.error as Record<string, unknown>;
      pending.reject(new Error(typeof errorRecord.message === 'string' ? errorRecord.message : 'Browser relay command failed.'));
      return;
    }
    pending.resolve(record.result);
  }

  private handleRelayClosed(): void {
    if (this.socket) {
      this.socket = null;
    }
    this.attachedTabs = [];
    if (this.server) {
      this.status = 'listening';
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser relay extension disconnected.'));
    }
    this.pending.clear();
    this.broadcastState();
  }

  private writeJson(res: http.ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }

  private getReason(): string | null {
    if (this.status === 'stopped') {
      return 'Start the local relay, then load the Chrome extension from the extension path.';
    }
    if (this.status === 'listening') {
      return 'Waiting for the Chrome extension to connect.';
    }
    if (this.status === 'connected') {
      return this.attachedTabs.length > 0
        ? `Chrome extension connected with ${this.attachedTabs.length} attached tab(s). Agent can use engine=relay.`
        : 'Chrome extension connected. Attach a tab from the extension popup or Browser Surface.';
    }
    return this.lastError;
  }

  private resolveExtensionPath(): string | null {
    const candidates = [
      process.env.CODE_AGENT_BROWSER_RELAY_EXTENSION_DIR,
      path.join(process.cwd(), 'resources', 'browser-relay-extension'),
      path.join(app.getAppPath(), 'resources', 'browser-relay-extension'),
      path.join(app.getAppPath(), '..', 'resources', 'browser-relay-extension'),
      path.join(String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || ''), 'resources', 'browser-relay-extension'),
      path.join(String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || ''), '_up_', 'resources', 'browser-relay-extension'),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'manifest.json'))) || null;
  }

  private broadcastState(): void {
    try {
      broadcastToRenderer(IPC_CHANNELS.MANAGED_BROWSER_SESSION_CHANGED, {
        reason: 'external_bridge',
      });
    } catch (error) {
      this.logger.warn('Failed to broadcast browser relay state', { error });
    }
  }
}

const browserRelayServiceInstance = new BrowserRelayService();
getServiceRegistry().register('BrowserRelayService', browserRelayServiceInstance);
export const browserRelayService = browserRelayServiceInstance;
