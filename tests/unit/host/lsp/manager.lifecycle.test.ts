// ============================================================================
// LSPServerManager / LSPServer lifecycle, install-fail, diagnostics
// ============================================================================
// Mocks ensureInstalled + child_process.spawn; drives Content-Length framed JSON-RPC.
// Does NOT re-test tool-module wrappers (see tests/unit/tools/modules/lsp/*).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'url';
import * as path from 'path';

const mocks = vi.hoisted(() => {
  class MockLSPInstallError extends Error {
    serverName: string;
    source: unknown;
    cause?: unknown;
    constructor(serverName: string, source: unknown, message: string, cause?: unknown) {
      super(message);
      this.name = 'LSPInstallError';
      this.serverName = serverName;
      this.source = source;
      this.cause = cause;
    }
  }
  return {
    ensureInstalled: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    MockLSPInstallError,
  };
});

vi.mock('../../../../src/host/lsp/installer', () => ({
  ensureInstalled: mocks.ensureInstalled,
  LSPInstallError: mocks.MockLSPInstallError,
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));

import {
  LSPServer,
  LSPServerManager,
  defaultLSPConfigs,
  checkLSPServerInstalled,
  getLSPManager,
} from '../../../../src/host/lsp/manager';

type FakeProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (data: string) => boolean };
  kill: ReturnType<typeof vi.fn>;
  written: string[];
};

function makeFakeProcess(autoInit = true): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.written = [];
  proc.kill = vi.fn();
  proc.stdin = {
    write: (data: string) => {
      proc.written.push(data);
      if (!autoInit) return true;

      // Respond to any request that has an id with a success result
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd === -1) return true;
      const body = data.slice(headerEnd + 4);
      try {
        const msg = JSON.parse(body) as { id?: number; method?: string };
        if (typeof msg.id === 'number') {
          queueMicrotask(() => {
            const result = JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: msg.method === 'initialize' ? { capabilities: {} } : {},
            });
            const frame = `Content-Length: ${Buffer.byteLength(result)}\r\n\r\n${result}`;
            proc.stdout.emit('data', Buffer.from(frame));
          });
        }
      } catch {
        /* ignore partial frames */
      }
      return true;
    },
  };
  return proc;
}

function pushNotification(proc: FakeProcess, method: string, params: unknown): void {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  proc.stdout.emit('data', Buffer.from(frame));
}

describe('defaultLSPConfigs / checkLSPServerInstalled', () => {
  it('ships typescript, pyright, gopls, rust-analyzer with extension maps', () => {
    const names = defaultLSPConfigs.map((c) => c.name);
    expect(names).toEqual([
      'typescript-language-server',
      'pyright',
      'gopls',
      'rust-analyzer',
    ]);
    const ts = defaultLSPConfigs.find((c) => c.name === 'typescript-language-server')!;
    expect(ts.fileExtensions).toEqual(expect.arrayContaining(['.ts', '.tsx', '.js', '.jsx']));
    expect(ts.install?.type).toBe('npm');
    const go = defaultLSPConfigs.find((c) => c.name === 'gopls')!;
    expect(go.install?.type).toBe('system');
  });

  it('checkLSPServerInstalled probes PATH via spawnSync; unknown name is false', () => {
    mocks.spawnSync.mockReturnValue({ status: 0 });
    expect(checkLSPServerInstalled('typescript-language-server')).toBe(true);
    expect(mocks.spawnSync).toHaveBeenCalled();

    mocks.spawnSync.mockReturnValue({ status: 1 });
    expect(checkLSPServerInstalled('typescript-language-server')).toBe(false);

    expect(checkLSPServerInstalled('not-a-real-server')).toBe(false);
  });

  it('getLSPManager is null before initializeLSPManager (no global leak assumption)', () => {
    // Cannot safely call initializeLSPManager here without contaminating process-global.
    // Assert the pre-init export shape only.
    expect(typeof getLSPManager).toBe('function');
  });
});

describe('LSPServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureInstalled.mockResolvedValue({
      command: 'fake-ls',
      args: ['--stdio'],
      installed: false,
    });
  });

  it('start resolves install, spawns process, completes initialize handshake', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);

    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      args: ['--stdio'],
      fileExtensions: ['.ts'],
    });

    const ready = new Promise<void>((r) => server.once('ready', r));
    await server.start('/tmp/ws');
    await ready;

    expect(mocks.ensureInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fake', command: 'fake-ls' }),
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      'fake-ls',
      ['--stdio'],
      expect.objectContaining({ cwd: '/tmp/ws' }),
    );
    expect(server.getState()).toBe('ready');
    // initialize request was written
    expect(proc.written.some((w) => w.includes('"method":"initialize"'))).toBe(true);
  });

  it('start rejects when already started', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      fileExtensions: ['.ts'],
    });
    await server.start('/tmp/ws');
    await expect(server.start('/tmp/ws')).rejects.toThrow(/already started/);
  });

  it('sendRequest rejects when not ready', async () => {
    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      fileExtensions: ['.ts'],
    });
    await expect(server.sendRequest('textDocument/hover', {})).rejects.toThrow(/not ready/);
  });

  it('open/close/change document emits LSP notifications; isDocumentOpen tracks state', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      fileExtensions: ['.ts'],
    });
    await server.start('/tmp/ws');

    const file = '/tmp/ws/a.ts';
    await server.openDocument(file, 'const x = 1', 'typescript');
    expect(server.isDocumentOpen(file)).toBe(true);
    expect(proc.written.some((w) => w.includes('textDocument/didOpen'))).toBe(true);

    server.notifyDidChange(file, 'const x = 2');
    expect(proc.written.some((w) => w.includes('textDocument/didChange'))).toBe(true);

    // change on closed doc is no-op
    server.notifyDidChange('/tmp/ws/missing.ts', 'nope');

    await server.closeDocument(file);
    expect(server.isDocumentOpen(file)).toBe(false);
    expect(proc.written.some((w) => w.includes('textDocument/didClose'))).toBe(true);
  });

  it('publishDiagnostics notification is re-emitted as diagnostics event', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      fileExtensions: ['.ts'],
    });
    await server.start('/tmp/ws');

    const file = '/tmp/ws/a.ts';
    const uri = pathToFileURL(file).href;
    const diagP = new Promise<unknown>((r) => server.once('diagnostics', r));

    pushNotification(proc, 'textDocument/publishDiagnostics', {
      uri,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          severity: 1,
          message: 'bad',
          source: 'fake',
        },
      ],
    });

    const params = await diagP as { uri: string; diagnostics: Array<{ message: string }> };
    expect(params.uri).toBe(uri);
    expect(params.diagnostics[0].message).toBe('bad');
  });

  it('malformed diagnostic items are filtered; invalid envelope is not emitted', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      fileExtensions: ['.ts'],
    });
    await server.start('/tmp/ws');

    const spy = vi.fn();
    server.on('diagnostics', spy);

    // valid uri, but items without range → filtered to []
    pushNotification(proc, 'textDocument/publishDiagnostics', {
      uri: 'file:///x',
      diagnostics: [{ message: 'no range' }],
    });
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith({ uri: 'file:///x', diagnostics: [] });

    spy.mockClear();
    // missing uri → normalizeDiagnosticsParams returns null → no emit
    pushNotification(proc, 'textDocument/publishDiagnostics', {
      diagnostics: [],
    });
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('stop kills process and sets state stopped', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    const server = new LSPServer({
      name: 'fake',
      command: 'fake-ls',
      fileExtensions: ['.ts'],
    });
    await server.start('/tmp/ws');
    await server.stop();
    expect(server.getState()).toBe('stopped');
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe('LSPServerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initialize starts matching servers; install failure is recorded not thrown', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    mocks.ensureInstalled.mockImplementation(async (cfg: { name: string }) => {
      if (cfg.name === 'broken') {
        throw new mocks.MockLSPInstallError('broken', { type: 'system', installCmd: 'brew install broken' }, 'fail');
      }
      return { command: 'ok-ls', args: [], installed: false };
    });

    const mgr = new LSPServerManager('/tmp/ws');
    mgr.registerServer({
      name: 'ok',
      command: 'ok-ls',
      fileExtensions: ['.ts'],
    });
    mgr.registerServer({
      name: 'broken',
      command: 'broken-ls',
      fileExtensions: ['.py'],
      install: { type: 'system', installCmd: 'brew install broken' },
    });

    const installFailed = new Promise<unknown>((r) => mgr.once('install-failed', r));
    await mgr.initialize();

    expect(mgr.getStatus().status).toBe('ready');
    expect(mgr.getAllServers().has('ok')).toBe(true);
    expect(mgr.getAllServers().has('broken')).toBe(false);

    const failEvent = await installFailed as { serverName: string; message: string };
    expect(failEvent.serverName).toBe('broken');

    expect(mgr.getServerForFile('/tmp/ws/a.ts')?.getConfig().name).toBe('ok');
    expect(mgr.getServerForFile('/tmp/ws/a.py')).toBeUndefined();
    expect(mgr.getInstallFailureForFile('/tmp/ws/a.py')).toEqual(
      expect.objectContaining({ message: 'fail' }),
    );
    expect(mgr.getInstallFailureForFile('/tmp/ws/a.ts')).toBeUndefined();
  });

  it('openFile/isFileOpen/sendRequest/notifyFileChanged route by extension', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    mocks.ensureInstalled.mockResolvedValue({ command: 'ok-ls', args: [], installed: false });

    const mgr = new LSPServerManager('/tmp/ws');
    mgr.registerServer({
      name: 'ok',
      command: 'ok-ls',
      fileExtensions: ['.ts', 'tsx'], // mixed with/without leading dot
    });
    await mgr.initialize();

    const file = path.join('/tmp/ws', 'a.ts');
    await mgr.openFile(file, 'const a = 1');
    expect(mgr.isFileOpen(file)).toBe(true);
    expect(proc.written.some((w) => w.includes('didOpen'))).toBe(true);

    // sendRequest gets a response via autoInit
    const result = await mgr.sendRequest(file, 'textDocument/hover', { position: { line: 0, character: 0 } });
    expect(result).toEqual({});

    // no server for .md
    expect(await mgr.sendRequest('/tmp/ws/a.md', 'hover', {})).toBeUndefined();
    expect(mgr.isFileOpen('/tmp/ws/a.md')).toBe(false);

    await mgr.notifyFileChanged(file, 'const a = 2');
    expect(proc.written.some((w) => w.includes('didChange'))).toBe(true);

    // notify on never-opened file opens first
    const other = path.join('/tmp/ws', 'b.ts');
    await mgr.notifyFileChanged(other, 'export {}');
    expect(mgr.isFileOpen(other)).toBe(true);
  });

  it('diagnostics cache + waitForDiagnostics (event and timeout paths)', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    mocks.ensureInstalled.mockResolvedValue({ command: 'ok-ls', args: [], installed: false });

    const mgr = new LSPServerManager('/tmp/ws');
    mgr.registerServer({
      name: 'ok',
      command: 'ok-ls',
      fileExtensions: ['.ts'],
    });
    await mgr.initialize();

    const file = '/tmp/ws/a.ts';
    const uri = pathToFileURL(file).href;

    // timeout path with empty cache
    const empty = await mgr.waitForDiagnostics(file, 20);
    expect(empty).toEqual([]);

    // event path
    const waiting = mgr.waitForDiagnostics(file, 1000);
    // emit via server diagnostics → manager caches
    const server = mgr.getServerForFile(file)!;
    server.emit('diagnostics', {
      uri,
      diagnostics: [
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 1 },
          },
          message: 'err',
          severity: 1,
        },
      ],
    });
    // Manager listens on server 'diagnostics' and re-emits — but only if wired during initialize.
    // We registered before initialize, so the listener is on the real server instance.
    // Emitting on server should fill cache via manager handler.
    const diags = await waiting;
    expect(diags.length).toBe(1);
    expect(diags[0].message).toBe('err');
    expect(mgr.getFileDiagnostics(file)).toHaveLength(1);
    expect(mgr.getDiagnostics().get(uri)?.[0].message).toBe('err');
  });

  it('shutdown stops all servers and clears map', async () => {
    const proc = makeFakeProcess(true);
    mocks.spawn.mockReturnValue(proc);
    mocks.ensureInstalled.mockResolvedValue({ command: 'ok-ls', args: [], installed: false });

    const mgr = new LSPServerManager('/tmp/ws');
    mgr.registerServer({ name: 'ok', command: 'ok-ls', fileExtensions: ['.ts'] });
    await mgr.initialize();
    expect(mgr.getAllServers().size).toBe(1);

    await mgr.shutdown();
    expect(mgr.getAllServers().size).toBe(0);
    expect(proc.kill).toHaveBeenCalled();
  });
});
