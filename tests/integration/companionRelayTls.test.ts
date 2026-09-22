import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:https';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { startCompanionRelayIfConfigured } from '../../src/host/services/companion/CompanionRelayClient';
import type { CompanionRelayClient } from '../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import type { CompanionRelayLogger } from '../../src/host/services/companion/companionRelayConfig';

const SECRET = 'CREDENTIAL_VALUE_MUST_NOT_APPEAR';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/companion-relay-tls');
const CA_PEM = join(FIXTURE_DIR, 'ca.pem');
const LEAF_PEM = join(FIXTURE_DIR, 'leaf.pem');
const LEAF_KEY = join(FIXTURE_DIR, 'leaf-key.pem');
const CERT_ERROR = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_UNTRUSTED|unable to verify/i;

describe('companion relay: private CA trust on host dial-out', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;

function collectLogger(): { logger: CompanionRelayLogger; warn: string[]; info: string[]; all(): string[] } {
  const warn: string[] = [];
  const info: string[] = [];
  return {
    warn,
    info,
    all: () => [...info, ...warn],
    logger: {
      warn: (message: string) => { warn.push(message); },
      info: (message: string) => { info.push(message); },
    },
  };
}

interface TlsRelay {
  url: string;
  authorizations: Array<string | undefined>;
  stop(): Promise<void>;
}

function startHttpRejectingTlsRelay(): Promise<TlsRelay> {
  const authorizations: Array<string | undefined> = [];
  const server: Server = createServer({
    cert: readFileSync(LEAF_PEM),
    key: readFileSync(LEAF_KEY),
  });
  server.on('upgrade', (request, sock) => {
    authorizations.push(request.headers.authorization);
    sock.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `wss://127.0.0.1:${port}`,
        authorizations,
        async stop() {
          await new Promise<void>(done => server.close(() => done()));
        },
      });
    });
  });
}

function startTlsRelay(): Promise<TlsRelay & { closeClients(code?: number, reason?: string): void; terminateClients(): void }> {
  const authorizations: Array<string | undefined> = [];
  const server: Server = createServer({
    cert: readFileSync(LEAF_PEM),
    key: readFileSync(LEAF_KEY),
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (_socket, request) => {
    authorizations.push(request.headers.authorization);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `wss://127.0.0.1:${port}`,
        authorizations,
        closeClients(code, reason) {
          for (const client of wss.clients) {
            if (code === undefined) client.close();
            else client.close(code, reason);
          }
        },
        terminateClients() {
          for (const client of wss.clients) client.terminate();
        },
        async stop() {
          for (const client of wss.clients) client.terminate();
          await new Promise<void>(done => wss.close(() => done()));
          await new Promise<void>(done => server.close(() => done()));
        },
      });
    });
  });
}

async function writeRelayConfig(url: string, caFile?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'companion-relay-tls-'));
  await writeFile(join(dir, L.relayConfigFile), JSON.stringify({
    v: 1,
    enabled: true,
    url,
    credentialRef: 'companion-relay',
    reconnectBackoffMs: [50, 50, 50],
    ...(caFile ? { caFile } : {}),
  }));
  return dir;
}

  let relay: TlsRelay | undefined;
  let client: CompanionRelayClient | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => ({ state: 'accepted', result: { runId: 'test-run' } }),
    });
  });

  afterEach(async () => {
    await client?.stop();
    client = null;
    await relay?.stop();
    relay = undefined;
    db.close();
  });

  it('fails TLS without caFile and logs the cert error only once across retries', async () => {
    relay = await startTlsRelay();
    const logs = collectLogger();
    const dir = await writeRelayConfig(relay.url);
    client = await startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => createIdentity(),
      credential: SECRET,
      logger: logs.logger,
      jitter: () => 0.5,
    });
    expect(client).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 280));
    const failures = logs.warn.filter(line => line.startsWith('Companion relay dial failed:'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(CERT_ERROR);
    expect(failures[0]).toMatch(/reconnect in 50ms/);
    expect(relay.authorizations).toEqual([]);
    expect(logs.all().join('\n')).not.toContain(SECRET);
    expect(logs.all().join('\n')).not.toMatch(/Bearer /);
  });

  it('fails HTTP 401 immediately as HTTP 401 instead of waiting for connect timeout', async () => {
    relay = await startHttpRejectingTlsRelay();
    const logs = collectLogger();
    const dir = await writeRelayConfig(relay.url, CA_PEM);
    const started = Date.now();
    client = await startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => createIdentity(),
      credential: SECRET,
      logger: logs.logger,
      jitter: () => 0.5,
    });
    const elapsed = Date.now() - started;
    expect(client).not.toBeNull();
    expect(elapsed).toBeLessThan(1000);
    expect(logs.warn.filter(line => line.startsWith('Companion relay dial failed:'))).toEqual([
      'Companion relay dial failed: HTTP 401; reconnect in 50ms',
    ]);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(logs.warn.filter(line => line.startsWith('Companion relay dial failed:'))).toEqual([
      'Companion relay dial failed: HTTP 401; reconnect in 50ms',
    ]);
    expect(logs.all().join('\n')).not.toContain('COMPANION_RELAY_CONNECT_TIMEOUT');
    expect(logs.all().join('\n')).not.toContain(SECRET);
  });

  it('connects when caFile points at the test CA and logs the connected line', async () => {
    relay = await startTlsRelay();
    const logs = collectLogger();
    const dir = await writeRelayConfig(relay.url, CA_PEM);
    client = await startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => createIdentity(),
      credential: SECRET,
      logger: logs.logger,
      jitter: () => 0.5,
    });
    expect(client).not.toBeNull();
    await client?.whenConnected();
    expect(relay.authorizations).toEqual([`Bearer ${SECRET}`]);
    expect(logs.info).toEqual([`Companion relay connected: ${new URL(relay.url).toString()}`]);
    expect(logs.warn.filter(line => line.startsWith('Companion relay dial failed:'))).toEqual([]);
    expect(logs.all().join('\n')).not.toContain(SECRET);
    expect(logs.info.join('\n')).not.toMatch(/Bearer /);
  });

  it('logs a live connection dropped by the relay as disconnected, not as a dial failure', async () => {
    const live = await startTlsRelay();
    relay = live;
    const logs = collectLogger();
    const dir = await writeRelayConfig(live.url, CA_PEM);
    client = await startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => createIdentity(),
      credential: SECRET,
      logger: logs.logger,
      jitter: () => 0.5,
    });
    await client?.whenConnected();
    live.closeClients(1000);
    await vi.waitFor(() => {
      expect(logs.warn.filter(line => line.startsWith('Companion relay disconnected:'))).toEqual([
        expect.stringMatching(/^Companion relay disconnected: close 1000; closeCode=1000 reason="" uptimeMs=\d+; reconnect in 50ms$/),
      ]);
    });
    expect(logs.warn.filter(line => line.startsWith('Companion relay dial failed:'))).toEqual([]);
  });

  it('distinguishes a frame-less TCP drop (1006) from a relay close frame in the disconnected line', async () => {
    const live = await startTlsRelay();
    relay = live;
    const logs = collectLogger();
    const dir = await writeRelayConfig(live.url, CA_PEM);
    client = await startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => createIdentity(),
      credential: SECRET,
      logger: logs.logger,
      jitter: () => 0.5,
    });
    await client?.whenConnected();
    live.terminateClients();
    await vi.waitFor(() => {
      expect(logs.warn.filter(line => line.startsWith('Companion relay disconnected:'))).toEqual([
        expect.stringMatching(/^Companion relay disconnected: close 1006; closeCode=1006 reason="" uptimeMs=\d+; reconnect in 50ms$/),
      ]);
    });
    expect(logs.all().join('\n')).not.toContain('COMPANION_RELAY_CONNECT_FAILED');
  });

  it('surfaces the relay close reason in the disconnected line', async () => {
    const live = await startTlsRelay();
    relay = live;
    const logs = collectLogger();
    const dir = await writeRelayConfig(live.url, CA_PEM);
    client = await startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => createIdentity(),
      credential: SECRET,
      logger: logs.logger,
      jitter: () => 0.5,
    });
    await client?.whenConnected();
    live.closeClients(1011, 'relay internal error');
    await vi.waitFor(() => {
      expect(logs.warn.filter(line => line.startsWith('Companion relay disconnected:'))).toEqual([
        expect.stringMatching(/^Companion relay disconnected: close 1011; closeCode=1011 reason="relay internal error" uptimeMs=\d+; reconnect in 50ms$/),
      ]);
    });
  });
});
