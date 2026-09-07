import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, Row } from '../../scripts/nightly/contracts';
import { captureReferencesAndFeedback, feedback } from '../../scripts/nightly/report';
import { runEmptyCase, type Resident } from '../../scripts/nightly/runtime';

const mocks = vi.hoisted(() => ({ home: '', exec: vi.fn(), launch: vi.fn() }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => mocks.home || actual.homedir() } };
});
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: mocks.exec }));
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }));
let home: string;
const spec: Case = { id: 'TC-M1-01', title: 'fixture', modules: ['上下文'], surfaces: ['api'], hash: 'frozen-spec', root: '~/fixture', reasons: [], fields: {} };
beforeEach(() => {
  vi.clearAllMocks(); home = mkdtempSync(path.join(os.tmpdir(), 'nightly-runtime-')); mocks.home = home;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.home = ''; rmSync(home, { recursive: true, force: true }); });
function state(): Resident {
  writeFileSync(path.join(home, '.dev-token'), 'fixture-local-token');
  return { dataDir: home, port: 1, pid: 1, caffeinatePid: 2, startedAt: 'fixture', build: {}, head: 'fixture' };
}
function credentials(mode = 0o600) {
  mkdirSync(path.join(home, '.ship/secrets'), { recursive: true });
  const file = path.join(home, '.ship/secrets/neo-dogfood.env');
  writeFileSync(file, 'NEO_DOGFOOD_EMAIL=probe@example.invalid\nNEO_DOGFOOD_PASSWORD=fixture-password\n'); chmodSync(file, mode);
}
describe('nightly runtime environment boundary', () => {
  it.each(['browser', 'missing credentials', 'credential mode', 'login rejected', 'session unavailable'])('%s is unexecuted with no CLI or feedback writes', async fault => {
    const close = vi.fn();
    mocks.launch.mockImplementation(async () => {
      if (fault === 'browser') throw new Error('browser unavailable');
      return { newPage: async () => ({ setDefaultTimeout: vi.fn() }), close };
    });
    if (!['browser', 'missing credentials'].includes(fault)) credentials(fault === 'credential mode' ? 0o644 : 0o600);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: !url.endsWith('/sessions'), status: url.endsWith('/sessions') ? 503 : 200, json: async () => ({ success: fault !== 'login rejected' }) })));
    const dir = path.join(home, 'run');
    const row = await runEmptyCase(spec, state(), dir, 'fixture-run');
    expect(row.status).toBe('未执行'); expect(row.reasons[0]).toContain('runner 前置环境不可用');
    expect(row.checks.map(c => c.status)).toEqual(['未执行', '未执行', '未执行']);
    expect(row.frames).toEqual([]); expect(row.fb).toBeUndefined(); expect(mocks.exec).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')).status).toBe('未执行');
    if (fault !== 'browser') expect(close).toHaveBeenCalledOnce();
  });
});
describe('nightly collector failures after the first observation', () => {
  it.each(['composer', 'screenshot'])('%s failures do not become product defects', async fault => {
    credentials();
    const close = vi.fn();
    const locator = {
      waitFor: async () => {}, isVisible: async () => true, click: async () => {},
      getByText: () => ({ isVisible: async () => true, count: async () => 1, isDisabled: async () => false }),
      innerText: async () => 'fixture',
      fill: async () => { throw new Error('collector composer selector timeout'); }
    };
    const page = {
      setDefaultTimeout: vi.fn(), context: () => ({ newCDPSession: async () => ({ send: async () => {}, on: vi.fn() }) }),
      exposeBinding: async () => {}, addInitScript: async () => {}, goto: async () => {},
      locator: () => locator, getByRole: () => ({ first: () => locator, last: () => ({ isVisible: async () => false }) }),
      keyboard: { press: async () => {} }, route: async () => {},
      screenshot: async ({ path: file }: { path: string }) => { if (fault === 'screenshot') throw new Error('collector screenshot unavailable'); writeFileSync(file, 'hermetic screenshot'); }
    };
    mocks.launch.mockResolvedValue({ newPage: async () => page, close });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith('/sessions') ? { data: { id: 'fixture-session' } } : url.includes('context/health') ? { data: null } : { success: true } })));
    const row = await runEmptyCase(spec, state(), path.join(home, 'run'), 'mid-collection');
    expect(row.status).toBe('未执行'); expect(row.checks.every(c => c.status === '未执行')).toBe(true);
    expect(row.reasons[0]).toContain(`collector ${fault}`); expect(row.fb).toBeUndefined();
    expect(mocks.exec).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
});
describe('nightly emergency stop', () => {
  it('dispatches stop with the brake set and without reading cases, verifying each owned PID', async () => {
    const dataDir = path.join(home, '.code-agent-nightly/instance'); mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(home, '.ship')); writeFileSync(path.join(home, '.ship/disabled'), 'brake');
    const resident = { ...state(), dataDir, pid: 4242, caffeinatePid: 4243 };
    writeFileSync(path.join(dataDir, 'nightly-resident.json'), JSON.stringify(resident));
    const alive = new Set([4242, 4243]); const verified = new Set<number>();
    mocks.exec.mockImplementation((_command, args: string[]) => { const pid = Number(args[1]); verified.add(pid); return pid === 4243 ? 'caffeinate -i -w 4242' : path.resolve('dist/web/webServer.cjs'); });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (!alive.has(pid)) throw new Error('ESRCH');
      if (signal !== 0) { expect(verified.has(pid)).toBe(true); alive.delete(pid); }
      return true;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.argv;
    try {
      process.argv = ['node', 'runner.ts', 'stop', dataDir, '--cases', path.join(home, 'absent-cases.md')];
      await import('../../scripts/nightly/runner');
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('STOPPED owned resident and caffeinate'));
      expect(alive.size).toBe(0); expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM'); expect(kill).toHaveBeenCalledWith(4243, 'SIGTERM');
      expect(readFileSync(path.join(home, '.ship/disabled'), 'utf8')).toBe('brake');
    } finally { process.argv = previous; }
  });
});
describe('nightly durable feedback deduplication', () => {
  it('reuses unresolved defects across runs, but separates fixed defects and mutations', () => {
    const items: Array<{ fb: string; source: string; state: string; path: string }> = [];
    let added = 0;
    mocks.exec.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'list') return JSON.stringify(items);
      expect(args[0]).toBe('add');
      const item = { fb: `FB-${++added}`, source: 'N-NIGHTLY-RUNNER', state: '待分诊', path: args[args.indexOf('--path') + 1] };
      items.unshift(item); return JSON.stringify(item);
    });
    const run = (id: string, mutation = false) => {
      const row: Row = { id: spec.id, runId: id, status: '失败', reasons: [], checks: [{ status: '失败', detail: `user=1 observed ${id.length}` }, { status: '通过', detail: 'trace' }, { status: '通过', detail: 'render' }], files: {}, frames: [] };
      const dir = path.join(home, id); mkdirSync(dir); writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ caseHash: spec.hash }));
      feedback(row, dir, '2026-09-06', mutation); return row;
    };
    expect(run('first').fbCreated).toBe(true);
    const second = run('second-longer'); expect(second.fb).toBe('FB-1'); expect(second.fbCreated).toBe(false); expect(added).toBe(1);
    expect(readFileSync(items[0].path, 'utf8')).toContain('second-longer');
    items[0].state = '已修'; expect(run('third').fb).toBe('FB-2');
    expect(run('mutation', true).fb).toBe('FB-3'); expect(added).toBe(3);
  });
  it('refuses feedback for a precondition skip', () => {
    const row: Row = { id: spec.id, runId: 'skip', status: '未执行', reasons: ['environment'], checks: [], files: {}, frames: [] };
    expect(() => feedback(row, home, '2026-09-06')).toThrow('only executed failed'); expect(mocks.exec).not.toHaveBeenCalled();
  });
});

describe('nightly auxiliary outages preserve the case for reporting', () => {
  it.each(['design', 'feedback', 'both'])('%s outage returns explicit errors without discarding the executed row', async fault => {
    const row: Row = { id: spec.id, runId: 'delivery-fault', status: '失败', reasons: [], checks: [1, 2, 3].map(() => ({ status: '失败', detail: 'observed product assertion' })), files: {}, frames: ['01', '02', '03'] };
    const dir = path.join(home, 'run'); mkdirSync(dir); writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ caseHash: spec.hash }));
    mocks.launch.mockImplementation(async () => {
      if (fault !== 'feedback') throw new Error('design file unavailable');
      return { newPage: async () => ({ goto: async () => {}, locator: () => ({ count: async () => 0 }) }), close: async () => {} };
    });
    mocks.exec.mockImplementation((_command, args: string[]) => {
      if (fault !== 'design') throw new Error('feedback service unavailable');
      return JSON.stringify(args[0] === 'list' ? [] : { fb: 'FB-1' });
    });
    const errors = await captureReferencesAndFeedback(row, dir, '2026-09-06');
    expect(errors).toHaveLength(fault === 'both' ? 2 : 1);
    expect(errors.join(' ')).toContain(fault === 'feedback' ? '缺陷回写失败' : '设计参照采集失败');
    expect(row.status).toBe('失败'); expect(row.frames).toHaveLength(3); expect(row.reasons).toEqual(errors);
    expect(JSON.parse(readFileSync(path.join(dir, 'delivery.json'), 'utf8')).errors).toEqual(errors);
    expect(row.fb).toBe(fault === 'design' ? 'FB-1' : undefined);
  });
});
