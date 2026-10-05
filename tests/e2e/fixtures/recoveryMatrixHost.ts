// Recovery-matrix process host: fresh tmp dirs, kill/restart the web server,
// repository seed, read-only DB readback, and one JSONL line per cell.
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type BetterSqlite3 from 'better-sqlite3';

import type { Message, Session } from '../../../src/shared/contract';
import type { ConversationBoundary } from '../../../src/shared/contract/conversationBranch';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOST_DIR, '..', '..', '..');
export const SHOT_DIR = path.join(REPO_ROOT, 'test-results', 'recovery-matrix');
export const CELL_LOG = path.join(SHOT_DIR, 'cells.jsonl');

const PLACEHOLDER_KEY = 'sk-e2e-placeholder';
const CLOSED_PORT_PROVIDERS = [
  'deepseek', 'claude', 'openai', 'gemini', 'groq', 'local', 'zhipu', 'qwen',
  'moonshot', 'minimax', 'perplexity', 'grok', 'openrouter', 'volcengine',
  'longcat', 'xiaomi', 'custom',
] as const;
const MODEL_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'ZHIPU_API_KEY',
  'ZHIPU_OFFICIAL_API_KEY',
  'QWEN_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_K25_API_KEY',
  'MINIMAX_API_KEY',
  'PERPLEXITY_API_KEY',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
  'VOLCENGINE_API_KEY',
  'LONGCAT_API_KEY',
  'XIAOMI_API_KEY',
  'CUSTOM_PROVIDER_API_KEY',
] as const;
/** Judgment-face key. A placeholder would look configured and dial out; drop it. */
const DELETED_ENV_KEYS = ['TYPESAFE_API_KEY'] as const;

interface FreshDirs {
  root: string;
  fakeHome: string;
  dataDir: string;
  workspace: string;
}

export interface ServerHandle {
  baseUrl: string;
  port: number;
  dirs: FreshDirs;
  child: ChildProcess;
  output: () => string;
}

export interface CellRecord {
  cell: string;
  injection: string;
  statusText: string;
  actions: string[];
  actionTaken: string;
  result: string;
  screenshot: string;
  dbReadback?: DbReadback | null;
  consistency?: string;
  gap?: string | null;
  notes?: string;
}

interface DbMessageRow {
  id: string;
  role: string;
  contentHead: string;
}

export interface DbReadback {
  sessionId: string;
  messages: DbMessageRow[];
  rolesInOrder: string[];
  duplicateAssistantOrTool: boolean;
  sessionEvents: Array<{ type: string; seq: number }>;
  durableRuns: Array<{ runId: string; sessionId: string; status: string; interruptCause: string | null }>;
  lineage: Array<{ sessionId: string; status: string; issueCodes: string[]; replay: string }>;
  lineageError?: string;
}

export async function makeFreshDirs(label: string): Promise<FreshDirs> {
  const root = await mkdtemp(path.join(os.tmpdir(), `recovery-matrix-${label}-`));
  const dirs: FreshDirs = {
    root,
    fakeHome: path.join(root, 'home'),
    dataDir: path.join(root, 'data'),
    workspace: path.join(root, 'workspace'),
  };
  await mkdir(dirs.fakeHome, { recursive: true });
  await mkdir(dirs.dataDir, { recursive: true });
  await mkdir(dirs.workspace, { recursive: true });
  return dirs;
}

export function shotPath(cell: string): string {
  return path.join(SHOT_DIR, `${cell}.png`);
}

export async function recordCell(cell: CellRecord): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  await appendFile(CELL_LOG, `${JSON.stringify(cell)}\n`, 'utf8');
}

export async function startServer(options: {
  dirs: FreshDirs;
  port?: number;
  localModel?: boolean;
  extraEnv?: Record<string, string>;
  isolateLoopback?: boolean;
  closedBaseUrlPort?: number;
}): Promise<ServerHandle> {
  const webServerPath = path.join(REPO_ROOT, 'dist', 'web', 'webServer.cjs');
  try {
    await access(webServerPath, constants.R_OK);
  } catch {
    throw new Error('dist/web/webServer.cjs missing — run npm run build:web && npm run build:renderer');
  }
  if (options.closedBaseUrlPort) {
    await writeClosedPortConfig(options.dirs.dataDir, options.closedBaseUrlPort);
  }
  const port = options.port ?? await allocatePort();
  const outputChunks: string[] = [];
  const logStream = createWriteStream(path.join(options.dirs.dataDir, 'webserver.log'), { flags: 'a' });
  const child = spawn(process.execPath, [webServerPath], {
    cwd: REPO_ROOT,
    env: serverEnv(options, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so one SIGKILL also reaps children holding the port or the db.
    detached: true,
  });
  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  const push = (chunk: string): void => {
    outputChunks.push(chunk);
    logStream.write(chunk);
  };
  stdout.on('data', (chunk) => push(String(chunk)));
  stderr.on('data', (chunk) => push(String(chunk)));
  child.on('exit', () => logStream.end());
  const server: ServerHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    dirs: options.dirs,
    child,
    output: () => outputChunks.join('').slice(-200_000),
  };
  await waitUntilHealthy(server);
  return server;
}

async function killServer(server: ServerHandle): Promise<void> {
  await signalAndWait(server, 'SIGKILL');
}

export async function stopServer(server: ServerHandle): Promise<void> {
  if (childHasExited(server.child)) return;
  signalChild(server.child, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (childHasExited(server.child)) return;
    await delay(100);
  }
  await signalAndWait(server, 'SIGKILL');
}

export async function restartServer(
  server: ServerHandle,
  options: Omit<Parameters<typeof startServer>[0], 'dirs' | 'port'> = {},
): Promise<ServerHandle> {
  const dirs = server.dirs;
  const port = server.port;
  await killServer(server);
  await delay(300);
  try {
    return await startServer({ ...options, dirs, port });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('EADDRINUSE')) throw error;
    return startServer({ ...options, dirs });
  }
}

export async function seedOrphanToolCall(dataDir: string, variant: 'D1' | 'D2'): Promise<{ sessionId: string }> {
  if (process.env.RECOVERY_MATRIX_DB_CHILD !== '1') {
    return runDbChild<{ sessionId: string }>('seed', dataDir, variant);
  }
  const { default: Database } = await import('better-sqlite3');
  const { SessionRepository } = await import('../../../src/host/services/core/repositories/SessionRepository');
  const { ToolExecutionEventRepository } = await import('../../../src/host/services/core/repositories/ToolExecutionEventRepository');
  const sessionId = variant === 'D1' ? 'recovery-d1-no-begin' : 'recovery-d2-with-begin';
  const now = Date.now();
  const db = new Database(path.join(dataDir, 'code-agent.db'));
  try {
    db.pragma('foreign_keys = ON');
    const sessionRepo = new SessionRepository(db);
    sessionRepo.createSession({
      id: sessionId,
      title: variant === 'D1' ? '恢复矩阵 D1' : '恢复矩阵 D2',
      modelConfig: { provider: 'openai', model: 'gpt-4o' },
      createdAt: now,
      updatedAt: now,
      status: 'running',
    } as Session);
    const toolCallId = `${sessionId}-call`;
    sessionRepo.addMessage(sessionId, {
      id: `${sessionId}-user`,
      role: 'user',
      content: 'recovery matrix orphan tool call',
      timestamp: now - 1,
    } as Message);
    sessionRepo.addMessage(sessionId, {
      id: `${sessionId}-assistant`,
      role: 'assistant',
      content: '',
      timestamp: now,
      toolCalls: [{ id: toolCallId, name: 'bash', arguments: { command: 'sleep 30' } }],
    } as Message);
    if (variant === 'D2') {
      new ToolExecutionEventRepository(db).appendBegin({
        executionId: `${sessionId}-execution`,
        sessionId,
        toolName: 'bash',
        summary: 'sleep 30',
        params: { command: 'sleep 30' },
        toolCallId,
        recordedAt: now + 1,
      });
    }
  } finally {
    db.close();
  }
  return { sessionId };
}

export async function readSessionDb(dataDir: string, sessionId: string): Promise<DbReadback> {
  if (process.env.RECOVERY_MATRIX_DB_CHILD !== '1') {
    return runDbChild<DbReadback>('read', dataDir, sessionId);
  }
  const { default: Database } = await import('better-sqlite3');
  const { ConversationBranchRepository } = await import('../../../src/host/services/core/repositories/ConversationBranchRepository');
  const db = new Database(path.join(dataDir, 'code-agent.db'), { readonly: true, fileMustExist: true });
  try {
    const messages = db.prepare(`
      SELECT id, role, content
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp, rowid
    `).all(sessionId) as Array<{ id: string; role: string; content: string }>;
    const eventColumns = new Set(
      (db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    const seqColumn = eventColumns.has('seq') ? 'seq' : 'id';
    const typeColumn = eventColumns.has('event_type') ? 'event_type' : 'type';
    const sessionEvents = eventColumns.size === 0
      ? []
      : db.prepare(`
          SELECT ${typeColumn} AS type, ${seqColumn} AS seq
          FROM session_events
          WHERE session_id = ?
          ORDER BY ${seqColumn}
        `).all(sessionId) as Array<{ type: string; seq: number }>;
    const hasDurableRuns = Boolean(db.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'`,
    ).get());
    const durableRuns = hasDurableRuns
      ? db.prepare(`
          SELECT run_id AS runId, session_id AS sessionId, status, envelope_json AS envelopeJson
          FROM durable_runs
        `).all() as Array<{ runId: string; sessionId: string; status: string; envelopeJson: string | null }>
      : [];
    const sessionIds = (db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>).map((row) => row.id);
    const lineage: DbReadback['lineage'] = [];
    let lineageError: string | undefined;
    const branchRepo = new ConversationBranchRepository(db);
    for (const id of sessionIds.length > 0 ? sessionIds : [sessionId]) {
      const boundary = readBoundary(db, id);
      try {
        const audit = branchRepo.auditLineage(id, boundary);
        let replay = 'ok';
        try {
          branchRepo.replay(id, boundary);
        } catch (error) {
          replay = errorText(error);
        }
        lineage.push({
          sessionId: id,
          status: audit.status,
          issueCodes: audit.issues.map((issue) => issue.code),
          replay,
        });
      } catch (error) {
        const text = errorText(error);
        lineageError = text;
        lineage.push({ sessionId: id, status: 'error', issueCodes: [text], replay: text });
      }
    }
    const mapped = messages.map((message) => ({
      id: message.id,
      role: message.role,
      contentHead: String(message.content ?? '').slice(0, 120),
    }));
    if (!hasDurableRuns) {
      lineageError = [lineageError, 'durable_runs table missing'].filter(Boolean).join('; ');
    }
    return {
      sessionId,
      messages: mapped,
      rolesInOrder: mapped.map((message) => message.role),
      duplicateAssistantOrTool: hasDuplicateAssistantOrTool(mapped),
      sessionEvents: sessionEvents.map((event) => ({ type: String(event.type), seq: Number(event.seq) })),
      durableRuns: durableRuns.map((run) => ({
        runId: run.runId,
        sessionId: run.sessionId,
        status: run.status,
        interruptCause: interruptCauseOf(run.envelopeJson),
      })),
      lineage,
      ...(lineageError ? { lineageError } : {}),
    };
  } finally {
    db.close();
  }
}

function lineageCodes(readback: DbReadback | null | undefined): string[] {
  if (!readback) return [];
  return readback.lineage.flatMap((entry) => [entry.status, ...entry.issueCodes, entry.replay]);
}

/** Hard invariants only: a dead-end cell, or a quarantined / mis-ordered projection. */
export function assertRecoveryInvariants(input: {
  cell: string;
  injectable: boolean;
  actions: string[];
  autoResolved: boolean;
  readback?: DbReadback | null;
}): void {
  if (!input.injectable) return;
  if (input.actions.length === 0 && !input.autoResolved) {
    throw new Error(`cell ${input.cell} has zero visible actions`);
  }
  const quarantined = (input.readback?.lineage ?? []).some((entry) => entry.status === 'quarantined');
  const codes = lineageCodes(input.readback);
  const blob = codes.join(' ');
  if (quarantined || blob.includes('BRANCH_QUARANTINED')) {
    throw new Error(`cell ${input.cell} BRANCH_QUARANTINED`);
  }
  if (blob.includes('PROJECTION_ALIAS_ORDER_MISMATCH')) {
    throw new Error(`cell ${input.cell} PROJECTION_ALIAS_ORDER_MISMATCH`);
  }
}

export function orderMatches(apiIds: string[], dbIds: string[]): boolean {
  if (apiIds.length !== dbIds.length) return false;
  return apiIds.every((id, index) => id === dbIds[index]);
}

export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Failed to allocate a local port')));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function serverEnv(
  options: {
    dirs: FreshDirs;
    localModel?: boolean;
    extraEnv?: Record<string, string>;
    isolateLoopback?: boolean;
    closedBaseUrlPort?: number;
  },
  port: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of MODEL_ENV_KEYS) env[key] = PLACEHOLDER_KEY;
  for (const key of DELETED_ENV_KEYS) delete env[key];
  if (options.closedBaseUrlPort) {
    env.OPENAI_BASE_URL = `http://127.0.0.1:${options.closedBaseUrlPort}/v1`;
  }
  env.HOME = options.dirs.fakeHome;
  env.CODE_AGENT_HOME = options.dirs.fakeHome;
  env.CODE_AGENT_DATA_DIR = options.dirs.dataDir;
  env.CODE_AGENT_WORKING_DIR = options.dirs.workspace;
  env.CODE_AGENT_E2E = '1';
  env.CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE = '1';
  env.WEB_HOST = '127.0.0.1';
  env.WEB_PORT = String(port);
  env.AGENT_NEO_BUNDLED_RUNTIME_ROOT = REPO_ROOT;
  if (options.localModel === false) delete env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL;
  else env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL = '1';
  if (options.isolateLoopback) {
    env.NO_PROXY = '127.0.0.1,localhost';
    env.no_proxy = env.NO_PROXY;
    delete env.HTTPS_PROXY;
    delete env.HTTP_PROXY;
    delete env.ALL_PROXY;
    delete env.https_proxy;
    delete env.http_proxy;
    delete env.all_proxy;
  }
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;
  return env;
}

async function writeClosedPortConfig(dataDir: string, port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const slot = { provider: 'openai', model: 'gpt-4o' };
  const providers: Record<string, { enabled: boolean; model: string; baseUrl: string; proxyMode: 'direct' }> = {};
  for (const id of CLOSED_PORT_PROVIDERS) {
    providers[id] = { enabled: true, model: 'gpt-4o', baseUrl, proxyMode: 'direct' };
  }
  const config = {
    onboarding: { completedAt: 1 },
    models: {
      default: 'openai',
      defaultProvider: 'openai',
      providers,
      routing: {
        code: slot,
        vision: slot,
        fast: slot,
        gui: slot,
      },
      taskStrategy: {
        mode: 'manual',
        profiles: {
          fast: slot,
          main: slot,
          deep: slot,
          vision: slot,
        },
        fallback: {
          enabled: false,
          preferSameProvider: true,
          allowCrossProvider: false,
        },
      },
    },
  };
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function waitUntilHealthy(server: ServerHandle): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (childHasExited(server.child)) {
      throw new Error(`webServer exited early with code ${server.child.exitCode} signal ${server.child.signalCode}\n${server.output()}`);
    }
    try {
      const response = await fetch(`${server.baseUrl}/api/health`);
      const health = await response.json() as { status?: string };
      if (response.ok && health.status === 'ok') return;
      lastError = JSON.stringify(health);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  await stopServer(server).catch(() => undefined);
  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

/** Node leaves exitCode null when the process dies from a signal; signalCode is the real marker. */
function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a process-group leader yet; signal the child directly.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}

async function signalAndWait(server: ServerHandle, signal: NodeJS.Signals): Promise<void> {
  if (childHasExited(server.child)) return;
  signalChild(server.child, signal);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (childHasExited(server.child)) return;
    await delay(50);
  }
  throw new Error(`webServer did not exit after ${signal} (pid ${server.child.pid ?? '?'})`);
}

function readBoundary(db: BetterSqlite3.Database, sessionId: string): ConversationBoundary {
  const row = db.prepare(`
    SELECT user_id AS ownerUserId, project_id AS projectId
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as { ownerUserId: string | null; projectId: string | null } | undefined;
  return {
    ownerUserId: row?.ownerUserId ?? null,
    projectId: row?.projectId ?? null,
  };
}

function interruptCauseOf(envelopeJson: string | null): string | null {
  if (!envelopeJson) return null;
  try {
    const parsed = JSON.parse(envelopeJson) as { interruptCause?: unknown; interrupt_cause?: unknown };
    const cause = parsed.interruptCause ?? parsed.interrupt_cause;
    return typeof cause === 'string' ? cause : null;
  } catch {
    return null;
  }
}

function hasDuplicateAssistantOrTool(messages: DbMessageRow[]): boolean {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'tool') continue;
    const key = `${message.role}\n${message.contentHead}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function runDbChild<T>(command: string, dataDir: string, extra: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      fileURLToPath(import.meta.url),
      command,
      dataDir,
      extra,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, RECOVERY_MATRIX_DB_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(errorText(new Error(`db child ${command} exited ${code}: ${err || out}`))));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch (error) {
        reject(new Error(errorText(new Error(
          `db child ${command} returned non-json (${error instanceof Error ? error.message : String(error)}): ${out.slice(0, 400)} stderr=${err.slice(0, 400)}`,
        ))));
      }
    });
  });
}

const dbChildCommand = process.env.RECOVERY_MATRIX_DB_CHILD === '1' ? process.argv[2] : undefined;
if (dbChildCommand === 'seed' || dbChildCommand === 'read') {
  const dataDir = process.argv[3] ?? '';
  const extra = process.argv[4] ?? '';
  const pending = dbChildCommand === 'seed'
    ? seedOrphanToolCall(dataDir, extra === 'D2' ? 'D2' : 'D1')
    : readSessionDb(dataDir, extra);
  pending.then(
    (result) => {
      process.stdout.write(JSON.stringify(result));
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    },
  );
}

function errorText(error: unknown): string {
  const raw = error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string'
    ? (() => {
      const coded = error as { code: string; message?: string };
      return coded.message ? `${coded.code}: ${coded.message}` : coded.code;
    })()
    : error instanceof Error ? error.message : String(error);
  return raw.replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
}
