import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackFingerprint, type Case, type Row } from '../../scripts/nightly/contracts';
import { captureReferencesAndFeedback, feedback } from '../../scripts/nightly/report';
import {
  evaluateEmptyCaseCheck1,
  evaluateTurnCostLedger,
  queryTurnCostLedger,
  runEmptyCase,
  type Resident,
} from '../../scripts/nightly/runtime';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const mocks = vi.hoisted(() => ({ home: '', exec: vi.fn(), launch: vi.fn() }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => mocks.home || actual.homedir() } };
});
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: mocks.exec }));
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }));
let home: string;
const spec: Case = { id: 'TC-M1-01', title: 'fixture', modules: ['上下文'], surfaces: ['api'], severity: '致命', frequency: '每轮', priority: 'P0', hash: 'frozen-spec', root: '~/fixture', reasons: [], fields: {} };
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
  it('a recurring failure adds exactly one FB and counts occurrences, even after the per-run inbox is swept', () => {
    const items: Array<{ fb: string; source: string; state: string; path: string }> = [];
    let added = 0;
    mocks.exec.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'list') return JSON.stringify(items);
      expect(args[0]).toBe('add');
      const item = { fb: `FB-${++added}`, source: 'N-NIGHTLY-RUNNER', state: '待分诊', path: args[args.indexOf('--path') + 1] };
      items.unshift(item); return JSON.stringify(item);
    });
    const run = (id: string) => {
      const row: Row = { id: spec.id, runId: id, status: '失败', reasons: [], checks: [{ status: '失败', detail: `user=1 observed ${id.length}` }, { status: '通过', detail: 'trace' }, { status: '通过', detail: 'render' }], files: {}, frames: [] };
      const dir = path.join(home, id); mkdirSync(dir); writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ caseHash: spec.hash }));
      feedback(row, dir, '2026-09-06'); return row;
    };
    expect(run('run-1').fbCreated).toBe(true);
    rmSync(path.join(home, '.ship/feedback-inbox'), { recursive: true, force: true }); // 旧条目的 sidecar 只活在带 run-id 的 inbox 里，清扫即失效
    const second = run('run-2');
    expect(second.fb).toBe('FB-1'); expect(second.fbCreated).toBe(false); expect(added).toBe(1);
    const registryDir = path.join(home, '.code-agent-nightly/feedback-registry');
    const files = readdirSync(registryDir);
    expect(files).toHaveLength(1);
    const registry = JSON.parse(readFileSync(path.join(registryDir, files[0]), 'utf8'));
    expect(registry.fb).toBe('FB-1'); expect(registry.occurrences).toBe(2); expect(registry.lastRun).toBe('run-2');
  });
  it('adopts a pre-registry pool entry through its sidecar and counts note recurrences', () => {
    const shape = { id: spec.id, status: '失败' as const, reasons: [], checks: [{ status: '失败' as const, detail: 'user=1 observed 5' }, { status: '通过' as const, detail: 'trace' }, { status: '通过' as const, detail: 'render' }], files: {}, frames: [] };
    const oldInbox = path.join(home, '.ship/feedback-inbox/2026-09-05-nightly-old-run-TC-M1-01');
    mkdirSync(oldInbox, { recursive: true });
    writeFileSync(path.join(oldInbox, 'feedback-signature.json'), JSON.stringify({ fingerprint: feedbackFingerprint({ ...shape, runId: 'old-run' } as Row, spec.hash, false) }));
    const oldNote = path.join(oldInbox, 'defect.md');
    writeFileSync(oldNote, `# 缺陷·${spec.id}\n\n1. 失败：user=1 observed 5\n\n复现 2026-09-05-run：~/.ship/feedback-inbox/2026-09-05-nightly\n`);
    const items = [{ fb: 'FB-9', source: 'N-NIGHTLY-RUNNER', state: '待分诊', path: oldNote }];
    let added = 0;
    mocks.exec.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'list') return JSON.stringify(items);
      expect(args[0]).toBe('add'); added += 1;
      return JSON.stringify({ fb: 'FB-10' });
    });
    const row: Row = { ...shape, runId: 'new-run' };
    const dir = path.join(home, 'new-run'); mkdirSync(dir); writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ caseHash: spec.hash }));
    feedback(row, dir, '2026-09-06');
    expect(added).toBe(0); expect(row.fb).toBe('FB-9');
    const registryDir = path.join(home, '.code-agent-nightly/feedback-registry');
    const registry = JSON.parse(readFileSync(path.join(registryDir, readdirSync(registryDir)[0]), 'utf8'));
    expect(registry.fb).toBe('FB-9'); expect(registry.occurrences).toBe(3); // 原始 1 次 + 旧格式复现行 1 次 + 本次 1 次
    expect(readFileSync(oldNote, 'utf8')).toContain('复现第 3 次 new-run');
  });
  it('fingerprints only failed assertions: run ids and passing-check drift never fork the key', () => {
    const failedRow = (runId: string): Row => ({ id: spec.id, runId, status: '失败', reasons: [], checks: [{ status: '失败', detail: 'user=1 observed 5' }, { status: '通过', detail: '费用=$0.01（账本，source=catalog）' }, { status: '通过', detail: 'render' }], files: {}, frames: [] });
    const drifted = failedRow('run-b'); drifted.checks[1].detail = '费用=$0.09（账本，source=catalog+estimate）';
    expect(feedbackFingerprint(drifted, spec.hash, false)).toBe(feedbackFingerprint(failedRow('run-a'), spec.hash, false));
    const otherAssertion = failedRow('run-c'); otherAssertion.checks = [{ status: '通过', detail: 'user=2 observed 5' }, { status: '失败', detail: 'user=1 observed 5' }, { status: '通过', detail: 'render' }];
    expect(feedbackFingerprint(otherAssertion, spec.hash, false)).not.toBe(feedbackFingerprint(failedRow('run-a'), spec.hash, false));
    expect(feedbackFingerprint(failedRow('run-a'), 'drifted-case-hash', false)).not.toBe(feedbackFingerprint(failedRow('run-a'), spec.hash, false));
    expect(feedbackFingerprint(failedRow('run-a'), spec.hash, true)).not.toBe(feedbackFingerprint(failedRow('run-a'), spec.hash, false));
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

const TURN_COST_ESTIMATES_SCHEMA = `
    CREATE TABLE IF NOT EXISTS turn_cost_estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      usd REAL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
`;

function openTurnCostFixture() {
  const db = new Database(':memory:');
  db.exec(TURN_COST_ESTIMATES_SCHEMA);
  return db;
}

function insertTurnCost(
  db: InstanceType<typeof Database>,
  row: { sessionId?: string; usd: number | null; source: string; input: number; output: number; createdAt?: number },
) {
  db.prepare(
    'INSERT INTO turn_cost_estimates (session_id, provider, model_id, input_tokens, output_tokens, usd, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(row.sessionId ?? 'session-1', 'fixture-provider', 'fixture-model', row.input, row.output, row.usd, row.source, row.createdAt ?? 1);
}

function ledgerCheck(db: InstanceType<typeof Database>, sessionId = 'session-1') {
  return evaluateTurnCostLedger(queryTurnCostLedger(db, sessionId));
}

describe('nightly empty-case cost ledger', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => { db = openTurnCostFixture(); });
  afterEach(() => { db.close(); });

  it('usd=0.001 passes the ledger cost assertion', () => {
    insertTurnCost(db, { usd: 0.001, source: 'catalog', input: 10, output: 10 });
    const result = ledgerCheck(db);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('费用=$0.001（账本，source=catalog）');
  });

  it('usd=0.9 fails as overspend', () => {
    insertTurnCost(db, { usd: 0.9, source: 'catalog', input: 10, output: 10 });
    const result = ledgerCheck(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('费用=$0.9（账本，source=catalog）；费用≤$0.05 或 token 阈值，缺遥测不推定为零');
  });

  it('null usd within token thresholds degrades to unpriced-channel check', () => {
    insertTurnCost(db, { usd: null, source: 'unknown', input: 6708, output: 25 });
    const result = ledgerCheck(db);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('无价渠道');
    expect(result.detail).toBe('无价渠道按 token 阈值核（in=6708/out=25，阈值 20000/500）');
  });

  it('null usd with output tokens above the threshold fails', () => {
    insertTurnCost(db, { usd: null, source: 'unknown', input: 6708, output: 9999 });
    const result = ledgerCheck(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('无价渠道');
    expect(result.detail).toContain('；费用≤$0.05 或 token 阈值，缺遥测不推定为零');
  });

  it('missing ledger rows fail instead of assuming zero cost', () => {
    const result = ledgerCheck(db);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('账本无本轮记录（费用遥测缺失≠通过）；费用≤$0.05 或 token 阈值，缺遥测不推定为零');
  });
});

describe('nightly empty-case initial snapshot', () => {
  const rest = {
    messages: [{ role: 'user' }],
    auditLength: 0,
    finalSnapshot: { tokenSource: 'provider' },
    expectedUserCount: 1,
  };

  it('timestamped all-zero snapshot passes check 1', () => {
    const check = evaluateEmptyCaseCheck1({
      initial: { currentTokens: 0, usagePercent: 0, compression: { status: 'none' }, lastUpdated: 1_725_000_000_000 },
      ...rest,
    });
    expect(check.status).toBe('通过');
    expect(check.detail).toContain('初始空快照（无快照或全零快照）');
  });

  it('initial snapshot with currentTokens>0 fails check 1', () => {
    const check = evaluateEmptyCaseCheck1({
      initial: { currentTokens: 128, usagePercent: 0, compression: { status: 'none' }, lastUpdated: 1_725_000_000_000 },
      ...rest,
    });
    expect(check.status).toBe('失败');
  });
});
