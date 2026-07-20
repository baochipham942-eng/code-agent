import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { URL } from 'url';
import type { ManagedBrowserExternalBridgeState } from '../../../shared/contract/desktop';
import {
  BROWSER_RELAY_CAPABILITIES_V2,
  BROWSER_RELAY_PROTOCOL_VERSION_V2,
  isBrowserRelayOwnerV2,
  isBrowserRelayResponseV2,
  type BrowserRelayCapabilityV2,
  type BrowserRelayCancelV2,
  type BrowserRelayCommandV2,
  type BrowserRelayErrorV2,
  type BrowserRelayHelloV2,
  type BrowserRelayLeaseApprovedV2,
  type BrowserRelayLeaseDeniedV2,
  type BrowserRelayLeaseRequestV2,
  type BrowserRelayOwnerV2,
  type BrowserRelayResponseV2,
  type BrowserRelayStableErrorCodeV2,
} from '../../../shared/contract/browserRelay';
import { app, broadcastToRenderer } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import { createLogger } from './logger';

const DEFAULT_RELAY_PORT = 23001;
const COMMAND_TIMEOUT_MS = 30_000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type RelayStatus = ManagedBrowserExternalBridgeState['status'];

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: BrowserRelayProtocolError) => void;
  timer: ReturnType<typeof setTimeout>;
  command: BrowserRelayCommandV2;
  detachAbort?: () => void;
}

interface PendingLeaseRequest {
  request: BrowserRelayLeaseRequestV2;
  resolve: (approval: BrowserRelayLeaseApprovedV2) => void;
  reject: (error: BrowserRelayProtocolError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserRelayCommandScopeV2 extends BrowserRelayOwnerV2 {
  leaseId: string;
  operationId: string;
  actionScope: string;
  deadlineMs?: number;
  abortSignal?: AbortSignal;
}

export class BrowserRelayProtocolError extends Error {
  constructor(readonly relayError: BrowserRelayErrorV2) {
    super(relayError.message);
    this.name = 'BrowserRelayProtocolError';
  }
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
  private pendingLeases = new Map<string, PendingLeaseRequest>();
  private token = crypto.randomBytes(32).toString('base64url');
  private port: number | null = null;
  private status: RelayStatus = 'stopped';
  private lastError: string | null = null;
  private lastConnectedAtMs: number | null = null;
  private connectionGeneration: string | null = null;
  private handshakeComplete = false;
  private extensionCapabilities = new Set<BrowserRelayCapabilityV2>();
  private activeLeaseIds = new Set<string>();
  private disconnectListeners = new Set<(leaseIds: string[]) => void>();

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
      pending.detachAbort?.();
      pending.reject(this.error(
        'RELAY_EXTENSION_DISCONNECTED',
        'Browser relay stopped before the command completed.',
        true,
        this.deliveryFor(pending.command.actionScope),
      ));
    }
    this.pending.clear();
    for (const pending of this.pendingLeases.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.error(
        'RELAY_EXTENSION_DISCONNECTED',
        'Browser relay stopped before tab approval completed.',
        true,
        'not_attempted',
      ));
    }
    this.pendingLeases.clear();
    this.notifyDisconnected();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.handshakeComplete = false;
    this.extensionCapabilities.clear();
    this.connectionGeneration = null;
    this.activeLeaseIds.clear();

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
      // Compatibility field remains in the public contract but raw key material
      // never crosses IPC/Renderer. Pairing is extension-only.
      authToken: null,
      tokenHint,
      extensionPath: this.resolveExtensionPath(),
      connectedTabCount: this.status === 'connected' ? 1 : 0,
      attachedTabCount: this.activeLeaseIds.size,
      lastConnectedAtMs: this.lastConnectedAtMs,
      lastError: this.lastError,
    };
  }

  getConnectionGeneration(): string | null {
    return this.connectionGeneration;
  }

  hasActiveLease(leaseId: string): boolean {
    return this.handshakeComplete && this.activeLeaseIds.has(leaseId);
  }

  onDisconnect(listener: (leaseIds: string[]) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async requestTabLease(input: BrowserRelayOwnerV2 & {
    requestId: string;
    domainScopes: string[];
    actionScopes: string[];
    ttlMs: number;
  }): Promise<BrowserRelayLeaseApprovedV2> {
    await this.ensureReady();
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 30 * 60_000) {
      throw this.error('RELAY_ACTION_NOT_ALLOWED', 'Relay lease TTL must be between 1ms and 30 minutes.', false, 'not_attempted');
    }
    if (this.pendingLeases.has(input.requestId)) {
      throw this.error('RELAY_COMMAND_FAILED', 'Relay lease requestId is already active.', false, 'not_attempted');
    }
    const request: BrowserRelayLeaseRequestV2 = {
      type: 'lease.request',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      requestId: input.requestId,
      surfaceSessionId: input.surfaceSessionId,
      conversationId: input.conversationId,
      runId: input.runId,
      agentId: input.agentId,
      domainScopes: this.explicitScopes(input.domainScopes, 'domain'),
      actionScopes: this.explicitScopes(input.actionScopes, 'action'),
      expiresAt: Date.now() + Math.floor(input.ttlMs),
    };
    return await new Promise<BrowserRelayLeaseApprovedV2>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLeases.delete(request.requestId);
        reject(this.error('RELAY_OPERATION_TIMEOUT', 'Relay tab approval timed out.', true, 'not_attempted'));
      }, Math.min(input.ttlMs, COMMAND_TIMEOUT_MS));
      this.pendingLeases.set(request.requestId, { request, resolve, reject, timer });
      this.socket?.sendJson(request);
    });
  }

  async executeLeasedCommand(
    scope: BrowserRelayCommandScopeV2,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.ensureReady();
    if (!scope.leaseId || !this.activeLeaseIds.has(scope.leaseId)) {
      throw this.error('RELAY_LEASE_REQUIRED', 'An active owner-scoped Relay tab lease is required.', false, 'not_attempted');
    }
    if (!scope.operationId.trim() || !scope.actionScope.trim() || !method.trim()) {
      throw this.error('RELAY_COMMAND_FAILED', 'Relay command requires operationId, actionScope, and method.', false, 'not_attempted');
    }
    this.rejectRawNativeTargets(params);
    const deadlineMs = Math.min(Math.max(Math.floor(scope.deadlineMs || COMMAND_TIMEOUT_MS), 1), COMMAND_TIMEOUT_MS);
    const id = `relay_${crypto.randomUUID()}`;
    const command: BrowserRelayCommandV2 = {
      type: 'command',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      id,
      surfaceSessionId: scope.surfaceSessionId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      agentId: scope.agentId,
      operationId: scope.operationId,
      leaseId: scope.leaseId,
      method,
      actionScope: scope.actionScope,
      deadlineAt: Date.now() + deadlineMs,
      params,
    };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.sendCancel(command, 'host-timeout');
        reject(this.error(
          'RELAY_OPERATION_TIMEOUT',
          `Browser relay command timed out: ${method}`,
          true,
          this.deliveryFor(scope.actionScope),
        ));
      }, deadlineMs);
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.sendCancel(command, typeof scope.abortSignal?.reason === 'string' ? scope.abortSignal.reason : 'host-abort');
        reject(this.error(
          'RELAY_OPERATION_CANCELLED',
          'Browser relay command was cancelled.',
          true,
          this.deliveryFor(scope.actionScope),
        ));
      };
      const detachAbort = scope.abortSignal
        ? () => scope.abortSignal?.removeEventListener('abort', onAbort)
        : undefined;
      if (scope.abortSignal?.aborted) {
        clearTimeout(timer);
        onAbort();
        return;
      }
      scope.abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, command, ...(detachAbort ? { detachAbort } : {}) });
      this.socket?.sendJson(command);
    });
  }

  async returnTabLease(scope: Omit<BrowserRelayCommandScopeV2, 'actionScope'>): Promise<unknown> {
    const result = await this.executeLeasedCommand(
      { ...scope, actionScope: 'lease:return' },
      'lease.return',
    );
    this.activeLeaseIds.delete(scope.leaseId);
    this.broadcastState();
    return result;
  }

  /** Legacy raw-tab APIs remain callable for source compatibility but are hard denied. */
  async listTabs(): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Relay tab metadata is available only inside an approved lease.', false, 'not_attempted');
  }

  async createTab(_url: string): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Relay tab creation requires a Surface owner and Agent Window lease.', false, 'not_attempted');
  }

  async navigateTab(_tabId: number, _url: string): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Raw Relay tab ids are not accepted.', false, 'not_attempted');
  }

  async attachTab(_tabId: number): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Tabs can be approved only from the extension popup.', false, 'not_attempted');
  }

  async detachTab(_tabId: number): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Tab return requires the owning Surface lease.', false, 'not_attempted');
  }

  async screenshotTab(_tabId: number): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Raw Relay tab ids are not accepted.', false, 'not_attempted');
  }

  async sendCdp(_tabId: number, _method: string): Promise<never> {
    throw this.error('RELAY_LEASE_REQUIRED', 'Raw Relay tab ids are not accepted.', false, 'not_attempted');
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private async ensureReady(): Promise<void> {
    await this.ensureStarted();
    if (!this.socket || this.status !== 'connected' || !this.handshakeComplete) {
      throw this.error(
        'RELAY_HANDSHAKE_REQUIRED',
        'Browser relay protocol v2 handshake is not complete.',
        true,
        'not_attempted',
      );
    }
  }

  private sendCancel(command: BrowserRelayCommandV2, reason: string): void {
    const cancel: BrowserRelayCancelV2 = {
      type: 'cancel',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      surfaceSessionId: command.surfaceSessionId,
      conversationId: command.conversationId,
      runId: command.runId,
      agentId: command.agentId,
      operationId: command.operationId,
      leaseId: command.leaseId,
      reason,
    };
    this.socket?.sendJson(cancel);
  }

  private explicitScopes(values: string[], kind: 'domain' | 'action'): string[] {
    const scopes = Array.isArray(values)
      ? values.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean)
      : [];
    if (scopes.length === 0 || scopes.some((scope) => scope.includes('*'))) {
      throw this.error(
        kind === 'domain' ? 'RELAY_DOMAIN_NOT_ALLOWED' : 'RELAY_ACTION_NOT_ALLOWED',
        `Relay ${kind} scopes must be explicit and non-empty.`,
        false,
        'not_attempted',
      );
    }
    return Array.from(new Set(scopes));
  }

  private rejectRawNativeTargets(value: unknown, depth = 0): void {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) this.rejectRawNativeTargets(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalized === 'tabid' || normalized === 'windowid' || normalized === 'debuggerid') {
        throw this.error('RELAY_TARGET_CHANGED', 'Relay commands cannot carry native tab, window, or debugger ids.', false, 'not_attempted');
      }
      this.rejectRawNativeTargets(child, depth + 1);
    }
  }

  private deliveryFor(actionScope: string): BrowserRelayErrorV2['delivery'] {
    return /^(?:input:|navigate|tab:|lease:return)/.test(actionScope) ? 'unknown' : 'not_attempted';
  }

  private error(
    code: BrowserRelayStableErrorCodeV2,
    message: string,
    retryable: boolean,
    delivery: BrowserRelayErrorV2['delivery'],
  ): BrowserRelayProtocolError {
    return new BrowserRelayProtocolError({ code, message, retryable, delivery });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port || DEFAULT_RELAY_PORT}`);
    if (req.method === 'GET' && requestUrl.pathname === '/api/browser-relay/config') {
      const extensionBootstrap = req.headers['x-agent-neo-relay-extension'] === BROWSER_RELAY_PROTOCOL_VERSION_V2;
      this.writeJson(res, {
        port: this.port,
        ...(extensionBootstrap ? { token: this.token } : {}),
        tokenHint: this.getState().tokenHint,
        status: this.status,
        protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
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
    let relaySocket: BrowserRelaySocket;
    relaySocket = new BrowserRelaySocket(
      socket,
      (message) => this.handleRelayMessage(message),
      () => {
        if (this.socket === relaySocket) this.handleRelayClosed();
      },
    );
    this.socket = relaySocket;
    this.status = 'listening';
    this.handshakeComplete = false;
    this.extensionCapabilities.clear();
    this.connectionGeneration = `relay-connection-${crypto.randomUUID()}`;
    this.lastError = null;
    this.broadcastState();
  }

  private handleRelayMessage(message: unknown): void {
    const record = message && typeof message === 'object' ? message as Record<string, unknown> : null;
    if (!record) return;

    if (record.type === 'hello') {
      this.handleHello(message as BrowserRelayHelloV2);
      return;
    }

    if (!this.handshakeComplete || record.protocolVersion !== BROWSER_RELAY_PROTOCOL_VERSION_V2) {
      this.lastError = 'Relay message rejected before protocol v2 handshake.';
      return;
    }

    if (record.type === 'lease.approved') {
      this.handleLeaseApproved(message as BrowserRelayLeaseApprovedV2);
      return;
    }
    if (record.type === 'lease.denied') {
      this.handleLeaseDenied(message as BrowserRelayLeaseDeniedV2);
      return;
    }
    if (record.type === 'lease.returned' || record.type === 'lease.recovery_required') {
      const leaseId = typeof record.leaseId === 'string' ? record.leaseId : '';
      if (record.type === 'lease.returned') this.activeLeaseIds.delete(leaseId);
      this.broadcastState();
      return;
    }
    if (!isBrowserRelayResponseV2(message)) return;
    this.handleResponse(message);
  }

  private handleHello(message: BrowserRelayHelloV2): void {
    const capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
    const validCapabilities = BROWSER_RELAY_CAPABILITIES_V2.every((capability) => capabilities.includes(capability));
    if (message.protocolVersion !== BROWSER_RELAY_PROTOCOL_VERSION_V2 || !validCapabilities) {
      this.status = 'error';
      this.lastError = message.protocolVersion !== BROWSER_RELAY_PROTOCOL_VERSION_V2
        ? 'Browser relay protocol version mismatch.'
        : 'Browser relay extension is missing required capabilities.';
      this.socket?.close();
      this.broadcastState();
      return;
    }
    this.extensionCapabilities = new Set(capabilities);
    this.handshakeComplete = true;
    this.status = 'connected';
    this.lastConnectedAtMs = Date.now();
    this.lastError = null;
    this.socket?.sendJson({
      type: 'hello_ack',
      protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
      connectionGeneration: this.connectionGeneration || `relay-connection-${crypto.randomUUID()}`,
      requiredCapabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
    });
    const orphaned = Array.isArray(message.orphanedLeaseIds)
      ? message.orphanedLeaseIds.filter((value): value is string => typeof value === 'string')
      : [];
    if (orphaned.length > 0) {
      for (const listener of this.disconnectListeners) listener([...orphaned]);
    }
    this.broadcastState();
  }

  private handleLeaseApproved(message: BrowserRelayLeaseApprovedV2): void {
    const pending = this.pendingLeases.get(message.requestId);
    if (!pending) return;
    this.pendingLeases.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!isBrowserRelayOwnerV2(message)
      || !this.sameOwner(message, pending.request)
      || message.expiresAt > pending.request.expiresAt
      || message.expiresAt <= Date.now()
      || !this.isDomainScopeSubset(message.domainScopes, pending.request.domainScopes)
      || !this.isScopeSubset(message.actionScopes, pending.request.actionScopes)
      || typeof message.leaseId !== 'string'
      || message.leaseId.length < 8
      || typeof message.approvalRef !== 'string'
      || message.approvalRef.length < 8) {
      pending.reject(this.error('RELAY_LEASE_NOT_OWNED', 'Relay approval did not match the pending owner and scope.', false, 'not_attempted'));
      return;
    }
    this.activeLeaseIds.add(message.leaseId);
    pending.resolve(structuredClone(message));
    this.broadcastState();
  }

  private handleLeaseDenied(message: BrowserRelayLeaseDeniedV2): void {
    const pending = this.pendingLeases.get(message.requestId);
    if (!pending) return;
    this.pendingLeases.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!isBrowserRelayOwnerV2(message) || !this.sameOwner(message, pending.request)) {
      pending.reject(this.error('RELAY_SESSION_NOT_OWNED', 'Relay denial owner did not match the pending request.', false, 'not_attempted'));
      return;
    }
    pending.reject(this.error('RELAY_LEASE_REQUIRED', 'The user denied the Relay tab lease.', false, 'not_attempted'));
  }

  private handleResponse(response: BrowserRelayResponseV2): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.operationId !== pending.command.operationId) {
      pending.reject(this.error('RELAY_SESSION_NOT_OWNED', 'Relay response operationId did not match the command.', false, 'unknown'));
    } else if (response.error) {
      pending.reject(this.protocolErrorFromExtension(response.error));
    } else {
      pending.resolve(response.result);
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.detachAbort?.();
  }

  private sameOwner(a: BrowserRelayOwnerV2, b: BrowserRelayOwnerV2): boolean {
    return a.surfaceSessionId === b.surfaceSessionId
      && a.conversationId === b.conversationId
      && a.runId === b.runId
      && a.agentId === b.agentId;
  }

  private isScopeSubset(candidate: unknown, allowed: string[]): candidate is string[] {
    return Array.isArray(candidate)
      && candidate.length > 0
      && candidate.every((scope) => typeof scope === 'string' && allowed.includes(scope));
  }

  private isDomainScopeSubset(candidate: unknown, allowed: string[]): candidate is string[] {
    if (!Array.isArray(candidate) || candidate.length === 0) return false;
    return candidate.every((scope) => {
      if (typeof scope !== 'string') return false;
      if (allowed.includes(scope)) return true;
      if (!allowed.includes('selected-tab-origin')) return false;
      try {
        const value = scope.startsWith('origin:') ? scope.slice('origin:'.length) : scope;
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
          && parsed.origin === value;
      } catch {
        return false;
      }
    });
  }

  private protocolErrorFromExtension(error: BrowserRelayErrorV2): BrowserRelayProtocolError {
    const known = new Set<BrowserRelayStableErrorCodeV2>([
      'RELAY_PROTOCOL_VERSION_MISMATCH',
      'RELAY_HANDSHAKE_REQUIRED',
      'RELAY_CAPABILITY_UNSUPPORTED',
      'RELAY_SESSION_NOT_OWNED',
      'RELAY_LEASE_REQUIRED',
      'RELAY_LEASE_NOT_OWNED',
      'RELAY_LEASE_EXPIRED',
      'RELAY_DOMAIN_NOT_ALLOWED',
      'RELAY_ACTION_NOT_ALLOWED',
      'RELAY_OPERATION_CANCELLED',
      'RELAY_OPERATION_TIMEOUT',
      'RELAY_EXTENSION_DISCONNECTED',
      'RELAY_TARGET_CHANGED',
      'RELAY_TAB_RETURN_FAILED',
      'RELAY_COMMAND_FAILED',
    ]);
    const code = known.has(error.code) ? error.code : 'RELAY_COMMAND_FAILED';
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.slice(0, 500)
      : 'Browser relay command failed.';
    return this.error(
      code,
      message,
      error.retryable === true,
      error.delivery === 'unknown' ? 'unknown' : 'not_attempted',
    );
  }

  private notifyDisconnected(): void {
    const leaseIds = [...this.activeLeaseIds];
    if (leaseIds.length === 0) return;
    for (const listener of this.disconnectListeners) listener([...leaseIds]);
  }

  private handleRelayClosed(): void {
    if (this.socket) {
      this.socket = null;
    }
    this.handshakeComplete = false;
    this.extensionCapabilities.clear();
    this.notifyDisconnected();
    if (this.server) {
      this.status = 'listening';
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.detachAbort?.();
      pending.reject(this.error(
        'RELAY_EXTENSION_DISCONNECTED',
        'Browser relay extension disconnected.',
        true,
        this.deliveryFor(pending.command.actionScope),
      ));
    }
    this.pending.clear();
    for (const pending of this.pendingLeases.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.error(
        'RELAY_EXTENSION_DISCONNECTED',
        'Browser relay extension disconnected before consent completed.',
        true,
        'not_attempted',
      ));
    }
    this.pendingLeases.clear();
    this.broadcastState();
  }

  private writeJson(res: http.ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
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
      return this.activeLeaseIds.size > 0
        ? `Chrome extension connected with ${this.activeLeaseIds.size} explicitly leased tab(s).`
        : 'Chrome extension connected. A Relay Surface must request a tab and the user must approve it in the extension popup.';
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
