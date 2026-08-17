import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile, appendFile, chmod } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { TraceReadService } from '../../src/host/app/traceReadService';
import { describeChildExit, isChildGone } from './childProcessState';

const root = path.resolve(import.meta.dirname, '../..');
const sourceDataDir = path.join(process.env.HOME ?? '', '.code-agent');
const dataDir = path.join(root, `.ledger-p4-headless-${process.pid}`);
const artifactDir = path.join(root, 'test-results', 'n-ledger-p4');
const sessionId = `session_ledger_p4_crash_${Date.now()}`;
const tracePath = path.join(dataDir, 'traces', `${sessionId}.jsonl`);
type HeadlessChild = ChildProcessByStdio<null, Readable, Readable>;

let child: HeadlessChild | null = null;
let output = '';

try {
  await prepareIsolatedDataDir();
  const port = await reservePort(8183);
  const serverChild = spawn(process.execPath, [path.join(root, 'dist/web/webServer.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: dataDir,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: root,
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
      AGENT_NEO_BUNDLED_RUNTIME_ROOT: root,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = serverChild;
  serverChild.stdout.setEncoding('utf8');
  serverChild.stderr.setEncoding('utf8');
  serverChild.stdout.on('data', (chunk) => { output = (output + chunk).slice(-200_000); });
  serverChild.stderr.on('data', (chunk) => { output = (output + chunk).slice(-200_000); });

  const token = await waitForReady(port);
  const runPromise = fetch(`http://127.0.0.1:${port}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      project: root,
      prompt: [
        '请按顺序逐个使用 Read 工具读取这些文件，每次只读一个，读完继续下一个：',
        'package.json、tsconfig.json、vitest.config.ts、src/host/agent/runtime/turnTrace.ts、',
        'src/host/app/traceReadService.ts、src/web/routes/agent.ts。',
        '完成全部读取后再统一简短回答，中途不要提前结束。',
      ].join(''),
    }),
  });

  const crashSnapshot = await waitForInTurnEvents();
  serverChild.kill('SIGKILL');
  await waitForExit(serverChild);
  child = null;
  await runPromise.then((response) => response.body?.cancel()).catch(() => undefined);

  await appendFile(tracePath, '{"type":"inference","data":', 'utf8');
  const read = await new TraceReadService(dataDir).readSession(sessionId);
  if (!read.events.some((event) => event.type === 'inference')) throw new Error('inference event missing after SIGKILL');
  if (!read.events.some((event) => event.type === 'tool_dispatch')) throw new Error('tool_dispatch event missing after SIGKILL');
  if (read.skippedLines !== 1) throw new Error(`partial line was not reported: skippedLines=${read.skippedLines}`);

  const finalBytes = await readFile(tracePath);
  await mkdir(artifactDir, { recursive: true });
  const report = {
    pass: true,
    sessionId,
    pidWasKilledBy: 'SIGKILL',
    eventCountBeforeKill: crashSnapshot.events.length,
    eventTypesBeforeKill: [...new Set(crashSnapshot.events.map((event) => event.type))],
    hadTurnOutcomeBeforeKill: crashSnapshot.events.some((event) => event.type === 'turn_outcome'),
    readEventCountAfterKill: read.events.length,
    skippedLines: read.skippedLines,
    traceBytes: finalBytes.byteLength,
    traceSha256: createHash('sha256').update(finalBytes).digest('hex'),
    testedAt: new Date().toISOString(),
  };
  await writeFile(path.join(artifactDir, 'headless-crash-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(output)}`);
} finally {
  if (child && !isChildGone(child)) {
    child.kill('SIGKILL');
    await waitForExit(child).catch(() => undefined);
  }
  await rm(dataDir, { recursive: true, force: true });
}

async function prepareIsolatedDataDir(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await copyFile(path.join(sourceDataDir, 'config.json'), path.join(dataDir, 'config.json'));
  await copyFile(path.join(sourceDataDir, '.env'), path.join(dataDir, '.env'));
  await Promise.all([chmod(path.join(dataDir, 'config.json'), 0o600), chmod(path.join(dataDir, '.env'), 0o600)]);
  const config = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8')) as {
    models?: { default?: string; defaultProvider?: string };
  };
  if (!config.models) throw new Error('production config has no models section');
  config.models.default = 'deepseek';
  config.models.defaultProvider = 'deepseek';
  await writeFile(path.join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function reservePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(`no free port in ${start}-${start + 99}`);
}

async function waitForReady(port: number): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child && isChildGone(child)) throw new Error(`webServer exited early: ${describeChildExit(child)}`);
    const startup = output.split('\n').find((line) => {
      try {
        const parsed = JSON.parse(line) as { port?: number; token?: string };
        return parsed.port === port && typeof parsed.token === 'string';
      } catch { return false; }
    });
    if (startup) {
      const token = (JSON.parse(startup) as { token: string }).token;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        const health = await response.json() as { status?: string; durableRunReady?: boolean };
        if (response.ok && health.status === 'ok' && health.durableRunReady === true) return token;
      } catch { /* server is still starting */ }
    }
    await delay(250);
  }
  throw new Error('webServer readiness timeout');
}

async function waitForInTurnEvents(): Promise<{ events: Array<{ type?: string }> }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean);
      const events = lines.map((line) => JSON.parse(line) as { type?: string });
      const types = new Set(events.map((event) => event.type));
      if (types.has('inference') && types.has('tool_dispatch') && !types.has('turn_outcome')) return { events };
      if (types.has('turn_outcome')) throw new Error('run settled before the crash checkpoint was observed');
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(50);
  }
  throw new Error('timed out waiting for incrementally flushed inference/tool events');
}

async function waitForExit(process: HeadlessChild): Promise<void> {
  if (isChildGone(process)) return;
  await new Promise<void>((resolve) => process.once('exit', () => resolve()));
}

function redact(value: string): string {
  return value
    .replace(/"token":"[^"]+"/g, '"token":"[REDACTED]"')
    .replace(/Auth token:\s+[^\s]+/g, 'Auth token: [REDACTED]')
    .slice(-20_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
