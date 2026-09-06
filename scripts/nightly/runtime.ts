import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, realpathSync, openSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import { chromium, type Browser, type Page } from 'playwright';
import { scopedHostLog, digest, type Case, type Row, type Check } from './contracts';

export const repo = path.resolve(import.meta.dirname, '../..');
export const expand = (p: string) => p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
export const scrub = (s: string): string => s.replaceAll(os.homedir(), '~').replace(/("(?:token|apiKey|access_token|refresh_token|password)"\s*:\s*")[^"]+/gi, '$1[REDACTED]').replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]');
export const save = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, scrub(JSON.stringify(value, null, 2)), { mode: 0o600 }); };
export type Resident = { dataDir: string; port: number; pid: number; caffeinatePid: number; startedAt: string; build: Record<string, string>; head: string };
const stateFile = (dataDir: string) => path.join(dataDir, 'nightly-resident.json');
function checkBrake() { if (existsSync(expand('~/.ship/disabled'))) throw new Error('FAIL emergency brake ~/.ship/disabled'); }
function safeEnv(dataDir: string, port?: number) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(['PATH', 'LANG', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
  return { ...env, CODE_AGENT_DATA_DIR: dataDir, CODE_AGENT_HOME: dataDir, CODE_AGENT_WORKING_DIR: dataDir, CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1', AGENT_NEO_BUNDLED_RUNTIME_ROOT: repo, WEB_HOST: '127.0.0.1', WEB_PORT: String(port ?? 0) };
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const addr = server.address() as net.AddressInfo; server.close(() => resolve(addr.port)); }); });
}
function ownedCommand(pid: number, feature: string) {
  const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  if (!command.includes(feature)) throw new Error(`FAIL PID ownership mismatch ${pid}`);
  return command;
}
export async function stopResident(state: Resident) {
  checkBrake();
  for (const [pid, feature] of [[state.caffeinatePid, `caffeinate -i -w ${state.pid}`], [state.pid, path.join(repo, 'dist/web/webServer.cjs')]] as const) {
    try { process.kill(pid, 0); } catch { continue; }
    ownedCommand(pid, feature);
    process.kill(pid, 'SIGTERM');
  }
  for (let i = 0; i < 50; i++) { try { process.kill(state.pid, 0); } catch { return; } await delay(100); }
  ownedCommand(state.pid, path.join(repo, 'dist/web/webServer.cjs'));
  process.kill(state.pid, 'SIGKILL');
}
export function loadResident(dataDir: string): Resident {
  const state = JSON.parse(readFileSync(stateFile(dataDir), 'utf8')) as Resident;
  state.dataDir = expand(state.dataDir);
  if (realpathSync(state.dataDir) !== realpathSync(dataDir) || !realpathSync(dataDir).startsWith(`${realpathSync(expand('~/.code-agent-nightly'))}/`)) throw new Error('FAIL isolated resident path mismatch');
  return state;
}
export async function api<T = Record<string, unknown>>(state: Resident, endpoint: string, body?: unknown): Promise<T> {
  const token = readFileSync(path.join(state.dataDir, '.dev-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${state.port}/api/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json() as { success?: boolean; data?: T };
  if (!response.ok || result.success === false) throw new Error(`FAIL HTTP ${response.status} ${endpoint}: ${scrub(JSON.stringify(result))}`);
  return result.data === undefined ? result as T : result.data;
}
export async function schedulerProbe(state: Resident): Promise<unknown> {
  checkBrake();
  try {
    ownedCommand(state.pid, path.join(repo, 'dist/web/webServer.cjs'));
    const health = await api<{ status: string; persistence?: { durable: boolean } }>(state, 'health');
    if (health.status !== 'ok' || health.persistence?.durable !== true) throw new Error('durable health unavailable');
    const job = await api<{ id: string }>(state, 'domain/cron/createJob', { payload: { name: 'nightly-scheduler-probe', runsOn: 'local', enabled: true, scheduleType: 'at', schedule: { type: 'at', datetime: new Date(Date.now() + 3000).toISOString() }, action: { type: 'webhook', url: `http://127.0.0.1:${state.port}/api/health`, method: 'GET' }, maxRetries: 0 } });
    try {
      for (let i = 0; i < 20; i++) {
        await delay(500);
        const executions = await api<Array<{ status: string }>>(state, 'domain/cron/getExecutions', { payload: { jobId: job.id, limit: 5 } });
        if (executions.some(e => e.status === 'completed')) return { health, job, executions };
      }
      throw new Error('scheduled tick did not complete');
    } finally { await api(state, 'domain/cron/deleteJob', { payload: { jobId: job.id } }); }
  } catch (error) { throw new Error(`FAIL 调度器未运行: ${scrub(String(error))}`, { cause: error }); }
}
export async function startResident(): Promise<Resident> {
  checkBrake();
  const dataDir = expand(`~/.code-agent-nightly/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const source = JSON.parse(readFileSync(expand('~/.code-agent-chatprobe/config.json'), 'utf8'));
  // Only model settings and the probe encryption pair cross the boundary; no production DB, roles or jobs.
  writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ models: source.models, cloud: { enabled: false, warmupOnInit: false }, connectors: { enabledNative: [] } }), { mode: 0o600 });
  writeFileSync(path.join(dataDir, '.env'), '', { mode: 0o600 });
  for (const file of ['.secure-key', 'secure-storage.json']) copyFileSync(expand(`~/.code-agent-chatprobe/${file}`), path.join(dataDir, file));
  const build: Record<string, string> = {};
  for (const file of ['dist/web/webServer.cjs', 'dist/cli/index.cjs', 'dist/renderer/index.html']) build[file] = digest(readFileSync(path.join(repo, file)));
  const port = await freePort();
  const logFile = path.join(dataDir, 'resident.raw.log');
  const logFd = openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(repo, 'dist/web/webServer.cjs')], { cwd: dataDir, env: safeEnv(dataDir, port), detached: true, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { detached: true, stdio: 'ignore' });
  const state: Resident = { dataDir, port, pid: child.pid!, caffeinatePid: awake.pid!, startedAt: new Date().toISOString(), build, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() };
  save(stateFile(dataDir), state);
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`FAIL resident exited ${child.exitCode}`);
      if (existsSync(path.join(dataDir, '.dev-token')) && readFileSync(logFile, 'utf8').includes('Cron service initialized')) { ready = true; break; }
      await delay(500);
    }
    if (!ready) throw new Error('FAIL 调度器未运行: initialization timeout');
    await schedulerProbe(state);
    const db = new Database(path.join(dataDir, 'code-agent.db'), { readonly: true });
    await db.backup(path.join(dataDir, 'fixture-baseline.backup')); db.close();
    child.unref(); awake.unref();
    return state;
  } catch (error) { await stopResident(state); throw error; }
}
export async function runEmptyCase(spec: Case, state: Resident, dir: string, runId: string, expectedUserCount = 1): Promise<Row> {
  mkdirSync(path.join(dir, 'screens'), { recursive: true });
  const row: Row = { id: spec.id, runId, status: '失败', reasons: [], checks: [], files: {}, frames: [], startedAt: new Date().toISOString() };
  type Health = { lastUpdated?: number; tokenSource?: string };
  type Trace = { receivedAt: string; eventName?: string; source?: string; data?: { type?: string; data?: { cost?: number }; [key: string]: unknown }; raw?: string };
  type ProcessEvidence = { source: string; types: Array<string | undefined>; tools: number; approvals: number; modelCalls: number | null; costs: number[] | null; subagents: Trace[]; steps: number };
  const observations: { caseHash: string; fixture: string; keySlot: string; adapter: string; responses: Array<Health | null>; sessionId?: string; error?: string; captureError?: string; process?: ProcessEvidence; checks?: Check[] } = { caseHash: spec.hash, fixture: 'F0: empty real session; transport request held before model delivery', keySlot: '~/.code-agent-chatprobe', adapter: 'browser send + native SSE JSONL + neo debug readonly', responses: [] };
  const trace: Trace[] = [];
  let browser: Browser | undefined;
  let page: Page;
  let caseStarted = false;
  let sessionId = '';
  const frame = async (name: string, expected: string[]) => {
    const index = String(row.frames.length + 1).padStart(2, '0');
    const criteria = [];
    for (const text of expected) {
      const locator = page.locator('[data-testid="context-health-detail"]').getByText(text, { exact: true });
      criteria.push({ scope: 'context-health-detail', locator: `getByText(${JSON.stringify(text)}, exact=true)`, text, visible: await locator.isVisible(), disabled: await locator.count() ? await locator.isDisabled() : null });
    }
    if (name === 'first-snapshot') {
      const detail = page.locator('[data-testid="context-health-detail"]');
      const visible = await detail.isVisible();
      const text = visible ? await detail.innerText() : '';
      criteria.push({ scope: 'context-health-detail', locator: '[data-testid="context-health-detail"]', text,
        visible: visible && observations.responses.at(-1)?.tokenSource === 'provider' && /\d+(?:\.\d+)?%/.test(text) && !/还没有健康度信息|等待统计上下文容量/.test(text), disabled: null });
    }
    await page.screenshot({ path: path.join(dir, `screens/${index}.png`) });
    save(path.join(dir, `screens/${index}.dom.json`), { event: name, timestamp: new Date().toISOString(), sessionId, snapshot: observations.responses.at(-1), criteria, body: await page.locator('body').innerText() });
    row.frames.push(index);
    console.log(`FRAME ${spec.id} ${index} ${name}`);
  };
  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    const credentialFile = expand('~/.ship/secrets/neo-dogfood.env');
    if ((statSync(credentialFile).mode & 0o777) !== 0o600) throw new Error('FAIL dogfood credentials must be mode 600');
    const credentials = parse(readFileSync(credentialFile));
    if (!credentials.NEO_DOGFOOD_EMAIL || !credentials.NEO_DOGFOOD_PASSWORD) throw new Error('FAIL dogfood login credentials missing');
    const login = await api(state, 'domain/auth/signInEmail', { payload: { email: credentials.NEO_DOGFOOD_EMAIL, password: credentials.NEO_DOGFOOD_PASSWORD } });
    if (login.success !== true) throw new Error('FAIL dogfood sign-in rejected');
    const session = await api<{ id: string }>(state, 'sessions', { title: `nightly-${runId}`, workingDirectory: state.dataDir });
    sessionId = session.id; observations.sessionId = sessionId;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.eventSourceMessageReceived', e => {
      try { trace.push({ receivedAt: new Date().toISOString(), eventName: e.eventName, data: JSON.parse(e.data) }); } catch { trace.push({ receivedAt: new Date().toISOString(), eventName: e.eventName, raw: e.data }); }
    });
    await page.exposeBinding('nightlyTrace', (_source, event) => { trace.push({ receivedAt: new Date().toISOString(), source: 'api/run SSE', data: event as Trace['data'] }); });
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        const input = args[0];
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url, location.href).pathname === '/api/run' && response.body) {
          const reader = response.clone().body!.getReader();
          const decoder = new TextDecoder();
          void (async () => {
            let buffer = ''; let eventType = 'message';
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n'); buffer = lines.pop()!;
                for (const line of lines) {
                  if (line.startsWith('event: ')) eventType = line.slice(7).trim();
                  if (!line.startsWith('data: ')) continue;
                  const raw = line.slice(6);
                  try { await (window as unknown as { nightlyTrace: (event: unknown) => Promise<void> }).nightlyTrace({ type: eventType, data: JSON.parse(raw) }); }
                  catch { await (window as unknown as { nightlyTrace: (event: unknown) => Promise<void> }).nightlyTrace({ raw }); }
                }
              }
            } catch (error) { await (window as unknown as { nightlyTrace: (event: unknown) => Promise<void> }).nightlyTrace({ captureError: String(error) }); }
          })();
        }
        return response;
      };
    });
    await page.goto(`http://127.0.0.1:${state.port}`);
    await page.locator('.h-screen').waitFor();
    // Real first-run dialogs, no DOM deletion or fake authenticated state.
    for (let i = 0; i < 3; i++) { const close = page.getByRole('button', { name: '关闭', exact: true }); if (await close.last().isVisible()) await close.last().click(); else break; }
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    observations.responses.push(await api<Health | null>(state, 'context/health/get', [sessionId]));
    const pill = page.getByRole('button', { name: /上下文.*使用|上下文.*健康/ }).first();
    const openDetail = async () => {
      const detail = page.locator('[data-testid="context-health-detail"]');
      try {
        if (!await detail.isVisible()) await pill.click();
        await detail.waitFor({ state: 'visible' });
      } catch (error) { throw new Error('CAPTURE_PRECONDITION: context health detail could not be opened', { cause: error }); }
    };
    await openDetail();
    caseStarted = true;
    await frame('empty', ['暂无上下文数据。', '还没有健康度信息']);
    await page.keyboard.press('Escape');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requestArrived!: () => void;
    const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
    await page.route('**/api/run', async route => { requestArrived(); await held; await route.continue(); });
    try {
      await page.locator('[data-testid="chat-composer-textarea"]').fill('请只回复 NIGHTLY_OK，不调用工具。');
      await page.locator('[data-testid="chat-composer-textarea"]').press('Enter');
      await Promise.race([arrived, delay(15000).then(() => { throw new Error('FAIL first message did not reach run endpoint'); })]);
      await openDetail();
      await frame('first-message-pending-provider', ['等待统计上下文容量']);
    } finally { release(); }
    for (let i = 0; i < 90; i++) {
      if (trace.some(e => JSON.stringify(e.data).includes('agent_complete'))) break;
      await delay(500);
    }
    observations.responses.push(await api<Health | null>(state, 'context/health/get', [sessionId]));
    await openDetail();
    await frame('first-snapshot', []);
  } catch (error) {
    observations.error = scrub(String(error));
    if (!caseStarted) {
      const reason = `runner 前置环境不可用：${observations.error}`;
      row.status = '未执行'; row.reasons = [reason];
      row.checks = [1, 2, 3].map(() => ({ status: '未执行', detail: reason }));
      row.endedAt = new Date().toISOString();
      save(path.join(dir, 'result.json'), { ...observations, checks: row.checks, status: row.status });
      writeFileSync(path.join(dir, 'host.log'), scopedHostLog('', ''));
      return row;
    }
    if (observations.error.includes('CAPTURE_PRECONDITION')) observations.captureError = observations.error;
    await frame('error', []).catch(e => { observations.captureError = scrub(String(e)); });
  } finally { await browser?.close(); }
  const db = new Database(path.join(state.dataDir, 'code-agent.db'), { readonly: true });
  const messages = sessionId ? db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp').all(sessionId) as Array<{ role: string }> : [];
  const audit = sessionId ? db.prepare('SELECT * FROM compaction_snapshots WHERE session_id = ?').all(sessionId) : [];
  const timeline = sessionId ? db.prepare('SELECT e.* FROM conversation_branch_events e JOIN conversation_branches b ON b.id=e.branch_id WHERE b.session_id=? ORDER BY e.sequence').all(sessionId) : [];
  db.close();
  save(path.join(dir, 'messages.json'), messages); save(path.join(dir, 'audit.json'), audit); save(path.join(dir, 'timeline.json'), timeline);
  writeFileSync(path.join(dir, 'trace.jsonl'), trace.map(e => scrub(JSON.stringify(e))).join('\n') + '\n');
  const cliPath = path.join(repo, 'dist/cli/index.cjs');
  const cli = spawn(process.execPath, [cliPath, 'debug', 'compact', 'diff', sessionId, '--json'], { cwd: state.dataDir, env: safeEnv(state.dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  cli.stdout.on('data', chunk => { stdout += String(chunk); });
  cli.stderr.on('data', chunk => { stderr += String(chunk); });
  const cliDone = new Promise<number | null>((resolve, reject) => { cli.once('error', reject); cli.once('exit', resolve); });
  save(path.join(dir, 'cli-process.json'), { pid: cli.pid, feature: scrub(cliPath) });
  const cliDeadline = Date.now() + 15000;
  while (cli.exitCode === null && cli.signalCode === null && Date.now() < cliDeadline) await delay(100);
  if (cli.exitCode === null && cli.signalCode === null) {
    ownedCommand(cli.pid!, cliPath); cli.kill('SIGTERM');
    await delay(1000);
    if (cli.exitCode === null && cli.signalCode === null) { ownedCommand(cli.pid!, cliPath); cli.kill('SIGKILL'); }
  }
  const cliExit = await cliDone;
  save(path.join(dir, 'stdout.json'), { command: 'neo debug compact diff <session> --json', stdout: scrub(stdout), stderr: scrub(stderr), exitCode: cliExit, signal: cli.signalCode });

  const hostLogs = readdirSync(path.join(state.dataDir, 'logs')).filter(f => f.endsWith('.log')).map(f => readFileSync(path.join(state.dataDir, 'logs', f), 'utf8')).join('\n');
  writeFileSync(path.join(dir, 'host.log'), scrub(scopedHostLog(readFileSync(path.join(state.dataDir, 'resident.raw.log'), 'utf8') + '\n' + hostLogs, sessionId)));
  const types = trace.filter(e => e.source === 'api/run SSE').map(e => e.data?.type);
  const terminal = types.includes('agent_complete');
  const tools = types.filter(t => t === 'tool_call_start').length;
  const approvals = types.filter(t => t === 'permission_request' || t === 'approval_requested').length;
  const modelCalls = types.filter(t => t === 'model_response').length;
  const cost = trace.map(e => e.data?.data?.cost).filter(v => typeof v === 'number');
  observations.process = { source: 'native SSE stream-json; missing fields remain unknown', types, tools, approvals, modelCalls: modelCalls || null, costs: cost.length ? cost : null, subagents: trace.filter(e => /subagent|agent_dispatch|agent_result/.test(e.data?.type ?? '')), steps: types.filter(t => /turn_start|tool_call_start/.test(t ?? '')).length };
  const check = (ok: boolean, detail: string): Check => ({ status: ok ? '通过' : '失败', detail });
  const initial = observations.responses[0];
  const finalSnapshot = observations.responses.at(-1);
  row.checks = [
    check(!observations.error && (initial === null || initial?.lastUpdated === 0) && messages.filter(m => m.role === 'user').length === expectedUserCount && audit.length === 0 && finalSnapshot?.tokenSource === 'provider', `初始空快照、user=${expectedUserCount}（实得 ${messages.filter(m => m.role === 'user').length}）、无压缩快照；见 result/messages/audit`),
    check(terminal && observations.process.steps <= 8 && observations.process.subagents.length === 0 && audit.length === 0 && modelCalls === 1 && tools === 0 && approvals === 0 && cost.length > 0 && cost.reduce((a, b) => a + b, 0) <= 0.05, `终态=${terminal}，主模型响应=${modelCalls || '未知'}，工具=${tools}，审批=${approvals}，费用=${cost.length ? cost.join('+') : '未知'}；费用≤$0.05，缺遥测不推定为零`),
    observations.captureError ? { status: '未执行', detail: observations.captureError } : check(row.frames.length === 3 && row.frames.every(f => { const dom = JSON.parse(readFileSync(path.join(dir, `screens/${f}.dom.json`), 'utf8')); return dom.criteria.length > 0 && dom.criteria.every((c: { visible: boolean }) => c.visible); }), '空态/等待态精确文本与三帧截图；稿 S-30/S-47/S-31')
  ];
  row.endedAt = new Date().toISOString();
  row.status = row.checks.every(c => c.status === '通过') ? '通过' : '失败';
  observations.checks = row.checks;
  save(path.join(dir, 'result.json'), observations);
  for (const name of ['result.json', 'trace.jsonl', 'timeline.json', 'audit.json', 'messages.json', 'stdout.json', 'host.log', ...row.frames.flatMap(f => [`screens/${f}.png`, `screens/${f}.dom.json`])]) row.files[name] = digest(readFileSync(path.join(dir, name)));
  writeFileSync(path.join(dir, 'files.sha256'), Object.entries(row.files).map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n');
  return row;
}
