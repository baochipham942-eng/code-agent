#!/usr/bin/env npx tsx

/**
 * Fork / Rewind acceptance smoke.
 *
 * This is deliberately local-only:
 * - a fresh temporary CODE_AGENT_DATA_DIR and HOME are used;
 * - the app host runs with CODE_AGENT_E2E=1 and renderer updates disabled;
 * - no model, provider, sync upload, or production API is invoked;
 * - user-visible mutations go through the public Web domain endpoint or the
 *   real Desktop session IPC handler.
 *
 * Run after a fresh web build:
 *   npm run build:web
 *   npx tsx scripts/acceptance/session-fork-smoke.ts --keep
 */

import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import type { Message } from '../../src/shared/contract/message';
import type { Session } from '../../src/shared/contract/session';
import type {
  CreateSessionForkResult,
  SessionForkLineageSummary,
} from '../../src/shared/contract/sessionFork';
import type {
  RestoreConversationRewindResult,
  RewindConversationResult,
} from '../../src/shared/contract/sessionRewind';
import type {
  ImportSessionForkResponse,
  SessionExportEnvelopeV2,
} from '../../src/shared/contract/sessionForkPortability';
import {
  prepareExternalEngineAcceptanceEnvironment,
  runExternalEngineProcessAcceptance,
} from './session-fork-external-engine-smoke';

type SQLiteRow = Record<string, unknown>;

interface IpcResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

interface StartedServer {
  baseUrl: string;
  token: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  networkAuditPath: string;
  output(): string;
}

interface NetworkAudit {
  policy: 'loopback-only';
  preloadPid: number;
  blockedExternalConnectionAttempts: Array<{
    kind: string;
    host: string;
    port: string | null;
    timestamp: number;
  }>;
}

interface FileManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

interface SourceDatabaseSnapshot {
  digest: string;
  session: SQLiteRow | null;
  messages: SQLiteRow[];
}

interface DatabaseCounts {
  sessions: number;
  messages: number;
  forks: number;
  forkMappings: number;
  rewinds: number;
  branches: number;
  branchReferences: number;
  branchEntries: number;
  branchEvents: number;
}

interface AcceptanceCheck {
  label: string;
  evidence?: unknown;
}

interface AcceptanceReport {
  ok: true;
  startedAt: string;
  completedAt: string;
  repoRoot: string;
  dataDir: string;
  workspaceRoot: string;
  build: {
    branch: string;
    gitHead: string;
    originMain: string;
    originMainAncestor: boolean;
    worktreeClean: boolean;
    worktreeStatusSha256: string;
    bundlePath: string;
    sha256: string;
    sizeBytes: number;
    mtimeMs: number;
    newestRelevantSourceMtimeMs: number;
    fresh: boolean;
    artifacts: {
      web: BuildArtifactFingerprint;
      renderer: BuildArtifactFingerprint | null;
      cli: BuildArtifactFingerprint | null;
    };
  };
  checks: AcceptanceCheck[];
  web: Record<string, unknown>;
  desktop: Record<string, unknown>;
  shell: Record<string, unknown>;
  network: Record<string, unknown>;
  database: Record<string, unknown>;
  files: Record<string, unknown>;
}

interface BuildArtifactFingerprint {
  path: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  fresh: boolean;
}

class DomainCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DomainCallError';
  }
}

const repoRoot = process.cwd();
const bundlePath = path.join(repoRoot, 'dist', 'web', 'webServer.cjs');
const bootstrapPath = path.join(
  repoRoot,
  'scripts',
  'acceptance',
  'session-fork-smoke-bootstrap.cjs',
);
const checks: AcceptanceCheck[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function requireCheck(condition: unknown, label: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const suffix = evidence === undefined ? '' : `\n${canonicalJson(evidence)}`;
    throw new Error(`FAIL: ${label}${suffix}`);
  }
  checks.push({ label, ...(evidence === undefined ? {} : { evidence }) });
  console.log(`  PASS ${label}`);
}

function parseOptions(argv: string[]): {
  keep: boolean;
  allowStaleBuild: boolean;
  requireCleanHead: boolean;
  requireFullBuild: boolean;
  evidenceDir?: string;
} {
  let evidenceDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence-dir') {
      evidenceDir = argv[index + 1];
      index += 1;
    }
  }
  return {
    keep: argv.includes('--keep') || process.env.SESSION_FORK_ACCEPTANCE_KEEP === '1',
    allowStaleBuild: argv.includes('--allow-stale-build'),
    requireCleanHead: argv.includes('--require-clean-head'),
    requireFullBuild: argv.includes('--require-full-build'),
    evidenceDir,
  };
}

async function latestMtime(root: string): Promise<number> {
  let latest = 0;
  const visit = async (target: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      const targetStat = await stat(target);
      latest = Math.max(latest, targetStat.mtimeMs);
      return;
    }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        latest = Math.max(latest, (await stat(child)).mtimeMs);
      }
    }
  };
  await visit(root);
  return latest;
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fingerprintArtifact(
  artifactPath: string,
  newestRelevantSourceMtimeMs: number,
): Promise<BuildArtifactFingerprint> {
  const artifactStat = await stat(artifactPath);
  return {
    path: artifactPath,
    sha256: sha256(await readFile(artifactPath)),
    sizeBytes: artifactStat.size,
    mtimeMs: artifactStat.mtimeMs,
    fresh: artifactStat.mtimeMs >= newestRelevantSourceMtimeMs,
  };
}

async function optionalArtifactPath(artifactPath: string): Promise<string | null> {
  return await access(artifactPath, constants.R_OK)
    .then(() => artifactPath)
    .catch(() => null);
}

async function rendererEntryPath(): Promise<string | null> {
  const indexPath = path.join(repoRoot, 'dist', 'renderer', 'index.html');
  const readableIndex = await optionalArtifactPath(indexPath);
  if (!readableIndex) return null;
  const html = await readFile(readableIndex, 'utf8');
  const entry = html.match(/<script[^>]+src="\.\/assets\/([^"]+\.js)"/)?.[1];
  return entry ? await optionalArtifactPath(path.join(repoRoot, 'dist', 'renderer', 'assets', entry)) : null;
}

async function readBuildFingerprint(
  allowStaleBuild: boolean,
  requireCleanHead: boolean,
  requireFullBuild: boolean,
): Promise<AcceptanceReport['build']> {
  await access(bundlePath, constants.R_OK).catch(() => {
    throw new Error('dist/web/webServer.cjs is missing. Run npm run build:web first.');
  });
  const relevantRoots = [
    path.join(repoRoot, 'src', 'web'),
    path.join(repoRoot, 'src', 'host', 'services', 'sessionFork'),
    path.join(repoRoot, 'src', 'host', 'services', 'sessionRewind'),
    path.join(repoRoot, 'src', 'host', 'services', 'core', 'repositories'),
    path.join(repoRoot, 'src', 'host', 'services', 'core', 'database'),
    path.join(repoRoot, 'src', 'host', 'app'),
    path.join(repoRoot, 'src', 'host', 'ipc'),
    path.join(repoRoot, 'src', 'renderer'),
    path.join(repoRoot, 'src', 'cli'),
    path.join(repoRoot, 'src', 'shared', 'contract'),
  ];
  const sourceMtimes = await Promise.all(relevantRoots.map(latestMtime));
  const newestRelevantSourceMtimeMs = Math.max(...sourceMtimes);
  const web = await fingerprintArtifact(bundlePath, newestRelevantSourceMtimeMs);
  const rendererPath = await rendererEntryPath();
  const cliPath = await optionalArtifactPath(path.join(repoRoot, 'dist', 'cli', 'index.cjs'));
  const renderer = rendererPath
    ? await fingerprintArtifact(rendererPath, newestRelevantSourceMtimeMs)
    : null;
  const cli = cliPath
    ? await fingerprintArtifact(cliPath, newestRelevantSourceMtimeMs)
    : null;
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
  const gitHead = gitOutput(['rev-parse', 'HEAD']);
  const originMain = gitOutput(['rev-parse', 'origin/main']);
  const worktreeStatus = gitOutput(['status', '--porcelain=v1', '--untracked-files=all']);
  const worktreeClean = worktreeStatus.length === 0;
  let originMainAncestor = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', originMain, gitHead], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    originMainAncestor = true;
  } catch {
    originMainAncestor = false;
  }
  requireCheck(
    web.fresh || allowStaleBuild,
    web.fresh
      ? 'web bundle is newer than Fork/Rewind sources'
      : 'stale bundle explicitly allowed for development-only smoke',
    { bundleMtimeMs: web.mtimeMs, newestRelevantSourceMtimeMs },
  );
  requireCheck(
    originMainAncestor,
    'acceptance HEAD descends from the fetched origin/main baseline',
    { gitHead, originMain },
  );
  requireCheck(
    !requireCleanHead || worktreeClean,
    requireCleanHead
      ? 'acceptance is bound to a clean feature HEAD'
      : 'dirty worktree explicitly allowed for development-only smoke',
    { branch, gitHead, worktreeStatusSha256: sha256(worktreeStatus) },
  );
  if (requireFullBuild) {
    requireCheck(
      Boolean(renderer?.fresh && cli?.fresh),
      'renderer and CLI artifacts are present and newer than Fork/Rewind sources',
      { renderer, cli, newestRelevantSourceMtimeMs },
    );
  }
  return {
    branch,
    gitHead,
    originMain,
    originMainAncestor,
    worktreeClean,
    worktreeStatusSha256: sha256(worktreeStatus),
    bundlePath,
    sha256: web.sha256,
    sizeBytes: web.sizeBytes,
    mtimeMs: web.mtimeMs,
    newestRelevantSourceMtimeMs,
    fresh: web.fresh,
    artifacts: { web, renderer, cli },
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function extractStartupToken(output: string, port: number): string | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as { port?: unknown; token?: unknown };
      if (parsed.port === port && typeof parsed.token === 'string' && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch {
      // Ignore non-startup JSON logs.
    }
  }
  return null;
}

async function waitForServer(server: StartedServer, port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`webServer exited early with ${server.child.exitCode}\n${server.output()}`);
    }
    const token = extractStartupToken(server.output(), port);
    if (token) {
      server.token = token;
      try {
        const response = await fetch(`${server.baseUrl}/api/health`);
        const health = await response.json() as {
          status?: string;
          persistence?: { status?: string; durable?: boolean; reason?: string };
        };
        if (
          response.ok
          && health.status === 'ok'
          && health.persistence?.status === 'available'
          && health.persistence.durable === true
        ) {
          return;
        }
        lastError = canonicalJson(health);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

function isolatedServerEnv(
  dataDir: string,
  fakeHome: string,
  workspaceRoot: string,
  port: number,
  networkAuditPath: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL,
    HOME: fakeHome,
    USER: 'neo-acceptance',
    SHELL: process.env.SHELL ?? '/bin/zsh',
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    CODE_AGENT_DATA_DIR: dataDir,
    CODE_AGENT_E2E: '1',
    CODE_AGENT_ENABLE_DEV_API: 'true',
    CODE_AGENT_WORKING_DIR: workspaceRoot,
    CODE_AGENT_RENDERER_HOT_UPDATE: 'false',
    CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
    CODE_AGENT_BOOT_TIMING: '0',
    AGENT_NEO_BUNDLED_RUNTIME_ROOT: repoRoot,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    SESSION_FORK_ACCEPTANCE_NETWORK_AUDIT: networkAuditPath,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    POSTHOG_API_KEY: '',
    LANGFUSE_PUBLIC_KEY: '',
    LANGFUSE_SECRET_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    ZHIPU_API_KEY: '',
  };
}

async function startServer(
  dataDir: string,
  fakeHome: string,
  workspaceRoot: string,
): Promise<StartedServer> {
  const port = await getFreePort();
  const networkAuditPath = path.join(dataDir, `network-audit-${port}.json`);
  const outputChunks: string[] = [];
  const child = spawn(process.execPath, ['--require', bootstrapPath, bundlePath], {
    cwd: repoRoot,
    env: isolatedServerEnv(dataDir, fakeHome, workspaceRoot, port, networkAuditPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => outputChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => outputChunks.push(String(chunk)));
  const server: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: '',
    child,
    networkAuditPath,
    output: () => outputChunks.join('').slice(-100_000),
  };
  try {
    await waitForServer(server, port);
    return server;
  } catch (error) {
    await stopServer(server).catch(() => undefined);
    throw error;
  }
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return;
    await delay(100);
  }
  server.child.kill('SIGKILL');
  await delay(100);
}

async function verifyNetworkAudit(
  server: StartedServer,
  label: string,
): Promise<NetworkAudit> {
  const audit = JSON.parse(await readFile(server.networkAuditPath, 'utf8')) as NetworkAudit;
  requireCheck(
    audit.policy === 'loopback-only'
      && audit.preloadPid === server.child.pid
      && Array.isArray(audit.blockedExternalConnectionAttempts),
    `${label} app host enforced loopback-only network isolation`,
    audit,
  );
  return audit;
}

async function requestJson<T>(
  server: StartedServer,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${server.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${pathname} returned non-JSON ${response.status}: ${text.slice(0, 1_000)}`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed ${response.status}: ${canonicalJson(payload)}`);
  }
  return payload as T;
}

async function api<T>(
  server: StartedServer,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<T> {
  const response = await requestJson<IpcResponse<T>>(server, method, pathname, body);
  if (!response.success) {
    throw new DomainCallError(
      response.error?.code ?? 'UNKNOWN',
      response.error?.message ?? `${method} ${pathname} failed`,
    );
  }
  return response.data as T;
}

async function domainResult<T>(
  server: StartedServer,
  action: string,
  payload: unknown,
): Promise<IpcResponse<T>> {
  return await requestJson<IpcResponse<T>>(
    server,
    'POST',
    `/api/domain/session/${encodeURIComponent(action)}`,
    {
      action,
      payload,
      requestId: `acceptance-${action}-${Date.now()}`,
    },
  );
}

async function domain<T>(
  server: StartedServer,
  action: string,
  payload: unknown,
): Promise<T> {
  const response = await domainResult<T>(server, action, payload);
  if (!response.success) {
    throw new DomainCallError(
      response.error?.code ?? 'UNKNOWN',
      response.error?.message ?? `${action} failed`,
    );
  }
  return response.data as T;
}

async function expectDomainFailure(
  server: StartedServer,
  action: string,
  payload: unknown,
  expectedCode: string,
): Promise<IpcResponse<never>> {
  const response = await domainResult<never>(server, action, payload);
  requireCheck(
    response.success === false && response.error?.code === expectedCode,
    `${action} fails closed with ${expectedCode}`,
    response,
  );
  return response;
}

async function createSession(
  server: StartedServer,
  title: string,
  workingDirectory: string,
): Promise<Session> {
  return await api<Session>(server, 'POST', '/api/sessions', {
    title,
    workingDirectory,
  });
}

async function seedMessages(
  server: StartedServer,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  const result = await requestJson<{ ok: boolean; count: number }>(
    server,
    'POST',
    '/api/dev/seed-messages',
    { sessionId, messages },
  );
  requireCheck(
    result.ok && result.count === messages.length,
    `seeded ${messages.length} persisted messages for ${sessionId}`,
    result,
  );
}

function conversation(timestamp: number, prefix = ''): Message[] {
  const id = (value: string): string => `${prefix}${value}`;
  return [
    { id: id('u1'), role: 'user', content: 'user one', timestamp },
    { id: id('a1'), role: 'assistant', content: 'assistant one', timestamp },
    { id: id('u2'), role: 'user', content: 'user two', timestamp },
    { id: id('a2'), role: 'assistant', content: 'assistant two', timestamp },
    { id: id('u3'), role: 'user', content: 'user three', timestamp },
  ];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function initializeWorkspace(workspaceRoot: string): Promise<string> {
  await mkdir(workspaceRoot, { recursive: true });
  git(workspaceRoot, ['init', '--quiet']);
  git(workspaceRoot, ['config', 'user.email', 'session-fork-acceptance@example.invalid']);
  git(workspaceRoot, ['config', 'user.name', 'Session Fork Acceptance']);
  await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'base\n', 'utf8');
  git(workspaceRoot, ['add', 'tracked.txt']);
  git(workspaceRoot, ['commit', '--quiet', '-m', 'base']);
  return git(workspaceRoot, ['rev-parse', 'HEAD']);
}

async function createAnchorWorkspaceState(workspaceRoot: string): Promise<FileManifestEntry[]> {
  await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'anchor staged\n', 'utf8');
  git(workspaceRoot, ['add', 'tracked.txt']);
  await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'anchor staged plus unstaged\n', 'utf8');
  await writeFile(path.join(workspaceRoot, 'anchor-untracked.txt'), 'anchor untracked\n', 'utf8');
  return await fileManifest(workspaceRoot);
}

async function createCurrentWorkspaceState(workspaceRoot: string): Promise<FileManifestEntry[]> {
  await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'current state after anchor\n', 'utf8');
  await writeFile(path.join(workspaceRoot, 'anchor-untracked.txt'), 'current untracked after anchor\n', 'utf8');
  await writeFile(path.join(workspaceRoot, 'current-only.txt'), 'current only\n', 'utf8');
  return await fileManifest(workspaceRoot);
}

async function fileManifest(root: string): Promise<FileManifestEntry[]> {
  const entries: FileManifestEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!relativeDirectory && child.name === '.git') continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({
          path: relativePath,
          sha256: sha256(bytes),
          sizeBytes: bytes.byteLength,
        });
      }
    }
  };
  await visit(root, '');
  return entries;
}

function manifestDigest(manifest: FileManifestEntry[]): string {
  return sha256(canonicalJson(manifest));
}

function readSourceDatabaseSnapshot(dbPath: string, sessionId: string): SourceDatabaseSnapshot {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SQLiteRow | undefined;
    const messages = db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as SQLiteRow[];
    return {
      session: session ?? null,
      messages,
      digest: sha256(canonicalJson({ session: session ?? null, messages })),
    };
  } finally {
    db.close();
  }
}

function readMessageContentDigest(dbPath: string, sessionId: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT rowid AS __rowid, id, session_id, role, content, timestamp,
             tool_calls, tool_results, attachments, thinking, effort_level,
             content_parts, metadata, is_meta, compaction
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as SQLiteRow[];
    return sha256(canonicalJson(rows));
  } finally {
    db.close();
  }
}

function tableCount(db: Database.Database, table: string): number {
  const exists = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(table);
  if (!exists) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function readDatabaseCounts(dbPath: string): DatabaseCounts {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return {
      sessions: tableCount(db, 'sessions'),
      messages: tableCount(db, 'messages'),
      forks: tableCount(db, 'session_forks'),
      forkMappings: tableCount(db, 'session_fork_message_map'),
      rewinds: tableCount(db, 'session_rewinds'),
      branches: tableCount(db, 'conversation_branches'),
      branchReferences: tableCount(db, 'conversation_branch_message_refs'),
      branchEntries: tableCount(db, 'conversation_entries'),
      branchEvents: tableCount(db, 'conversation_branch_events'),
    };
  } finally {
    db.close();
  }
}

function readSessionSidecarCounts(dbPath: string, sessionId: string): Record<string, number> {
  const tables = [
    'todos',
    'session_tasks',
    'session_task_events',
    'context_interventions',
    'session_runtime_state',
    'queued_inputs',
    'agent_wakes',
    'permission_decisions',
    'tool_execution_events',
    'durable_runs',
  ];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return Object.fromEntries(tables.map((table) => {
      const exists = db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
      `).get(table);
      if (!exists) return [table, 0];
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count: number };
      return [table, Number(row.count)];
    }));
  } finally {
    db.close();
  }
}

function readRewindRows(dbPath: string, sessionId: string): SQLiteRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT *
      FROM session_rewinds
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as SQLiteRow[];
  } finally {
    db.close();
  }
}

function seedRewindGenerativeUi(
  dbPath: string,
  sessionId: string,
  sourceMessageId: string,
  createdAt: number,
): { instanceId: string; manifestId: string } {
  const db = new Database(dbPath, { fileMustExist: true });
  const instanceId = `acceptance-rewind-ui-${sessionId}`;
  const manifestId = `acceptance-rewind-manifest-${sessionId}`;
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO generative_ui_instances (
          instance_id, session_id, source_message_id, source_ordinal, source_key,
          spec_hash, spec_json, state_json, state_revision, status,
          hidden_by_rewind_id, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, 'acceptance-spec', '{}', '{}', 0, 'active', NULL, ?, ?)
      `).run(
        instanceId,
        sessionId,
        sourceMessageId,
        `acceptance-rewind-source:${sessionId}`,
        createdAt,
        createdAt,
      );
      db.prepare(`
        INSERT INTO execution_manifests (
          manifest_id, session_id, instance_id, nonce, scope_hash,
          title, summary, items_json, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'acceptance-nonce', 'acceptance-scope',
                  'Acceptance manifest', 'Rewind authority check', '[]',
                  'approved', ?, ?, ?)
      `).run(manifestId, sessionId, instanceId, createdAt + 60_000, createdAt, createdAt);
    })();
    return { instanceId, manifestId };
  } finally {
    db.close();
  }
}

function readRewindGenerativeUi(
  dbPath: string,
  instanceId: string,
  manifestId: string,
): { instance: SQLiteRow | null; manifest: SQLiteRow | null } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return {
      instance: (db.prepare(`
        SELECT instance_id, status, hidden_by_rewind_id, updated_at
        FROM generative_ui_instances
        WHERE instance_id = ?
      `).get(instanceId) as SQLiteRow | undefined) ?? null,
      manifest: (db.prepare(`
        SELECT manifest_id, status, invalidation_reason
        FROM execution_manifests
        WHERE manifest_id = ?
      `).get(manifestId) as SQLiteRow | undefined) ?? null,
    };
  } finally {
    db.close();
  }
}

function readWorkspaceEvidenceRows(dbPath: string, sourceSessionId: string): {
  evidence: SQLiteRow[];
  sagas: SQLiteRow[];
  intents: SQLiteRow[];
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      evidence: db.prepare(`
        SELECT id, source_session_id, anchor_message_id, project_id,
               workspace_scope_version, source_identity_digest, message_digest,
               repository_root, base_commit, observed_head, evidence_digest,
               summary_json, status, blocked_reason
        FROM session_fork_anchor_evidence
        WHERE source_session_id = ?
        ORDER BY anchor_message_id
      `).all(sourceSessionId) as SQLiteRow[],
      sagas: db.prepare(`
        SELECT *
        FROM session_fork_workspace_sagas
        WHERE source_session_id = ?
        ORDER BY created_at, intent_id
      `).all(sourceSessionId) as SQLiteRow[],
      intents: db.prepare(`
        SELECT intent_id, source_session_id, proposed_child_session_id,
               repository_root, workspace_path, evidence_digest, status,
               advertisable, created_at, updated_at
        FROM session_fork_workspace_intents
        WHERE source_session_id = ?
        ORDER BY created_at, intent_id
      `).all(sourceSessionId) as SQLiteRow[],
    };
  } finally {
    db.close();
  }
}

function assertCountsEqual(before: DatabaseCounts, after: DatabaseCounts, label: string): void {
  requireCheck(canonicalJson(before) === canonicalJson(after), label, { before, after });
}

async function assertForkPrefix(
  server: StartedServer,
  result: CreateSessionForkResult,
  expectedSourceMessages: Message[],
): Promise<Message[]> {
  const childMessages = await domain<Message[]>(server, 'getMessages', {
    sessionId: result.childSession.id,
  });
  requireCheck(
    canonicalJson(childMessages.map(({ role, content, timestamp }) => ({ role, content, timestamp })))
      === canonicalJson(
        expectedSourceMessages
          .slice(0, 4)
          .map(({ role, content, timestamp }) => ({ role, content, timestamp })),
      ),
    'a2 Fork copies the exact [u1,a1,u2,a2] stable prefix',
    childMessages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })),
  );
  requireCheck(
    childMessages.every((message) => message.timestamp === expectedSourceMessages[0].timestamp),
    'equal timestamps preserve insertion/rowid order',
  );
  requireCheck(
    result.messageMappings.map((mapping) => mapping.sourceMessageId).join(',')
      === expectedSourceMessages.slice(0, 4).map((message) => message.id).join(','),
    'message mapping records exact source order',
    result.messageMappings,
  );
  return childMessages;
}

async function runWebAcceptance(input: {
  server: StartedServer;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  baseCommit: string;
}): Promise<{
  result: Record<string, unknown>;
  rewind: {
    sessionId: string;
    rewindId: string;
    contentDigest: string;
    instanceId: string;
    manifestId: string;
  };
  desktopSessionId: string;
  sourceSessionId: string;
  sharedChildId: string;
  isolatedChildId: string;
  anchorManifest: FileManifestEntry[];
  currentManifest: FileManifestEntry[];
}> {
  const { server, dbPath, workspaceRoot, baseCommit } = input;
  const timestamp = 1_777_777_777_777;
  const sourceMessages = conversation(timestamp);
  const source = await createSession(server, 'Fork source', workspaceRoot);

  await seedMessages(server, source.id, sourceMessages.slice(0, 2));
  const anchorManifest = await createAnchorWorkspaceState(workspaceRoot);
  await seedMessages(server, source.id, sourceMessages.slice(2));
  const evidenceRows = readWorkspaceEvidenceRows(dbPath, source.id);
  const a2Evidence = evidenceRows.evidence.find((row) => row.anchor_message_id === 'a2');
  requireCheck(
    a2Evidence?.status === 'complete'
      && a2Evidence.base_commit === baseCommit
      && typeof a2Evidence.evidence_digest === 'string',
    'a2 captured complete base/diff/untracked/path evidence before Fork',
    a2Evidence,
  );

  const currentManifest = await createCurrentWorkspaceState(workspaceRoot);
  const sourceBeforeFork = readSourceDatabaseSnapshot(dbPath, source.id);
  const sourceFilesBeforeFork = await fileManifest(workspaceRoot);

  const sharedRequest = {
    sourceSessionId: source.id,
    anchorAssistantMessageId: 'a2',
    idempotencyKey: 'acceptance-shared-a2',
    workspaceMode: 'shared_current' as const,
  };
  const shared = await domain<CreateSessionForkResult>(server, 'fork', sharedRequest);
  await assertForkPrefix(server, shared, sourceMessages);
  requireCheck(
    shared.workspaceLabel === '历史对话 + 当前文件'
      && shared.childSession.workingDirectory === workspaceRoot
      && shared.lineage.workspaceMode === 'shared_current',
    'shared_current explicitly binds history to current source files',
    { workspaceLabel: shared.workspaceLabel, workingDirectory: shared.childSession.workingDirectory },
  );
  const repeated = await domain<CreateSessionForkResult>(server, 'fork', sharedRequest);
  requireCheck(
    repeated.childSession.id === shared.childSession.id
      && repeated.lineage.forkId === shared.lineage.forkId
      && repeated.sourcePrefixDigest === shared.sourcePrefixDigest,
    'repeated Fork idempotency key returns exactly one child',
    {
      firstChildId: shared.childSession.id,
      repeatedChildId: repeated.childSession.id,
      forkId: shared.lineage.forkId,
    },
  );

  const isolated = await domain<CreateSessionForkResult>(server, 'fork', {
    sourceSessionId: source.id,
    anchorAssistantMessageId: 'a2',
    idempotencyKey: 'acceptance-isolated-a2',
    workspaceMode: 'isolated_at_anchor',
  });
  await assertForkPrefix(server, isolated, sourceMessages);
  const isolatedPath = isolated.childSession.workingDirectory;
  requireCheck(
    isolated.workspaceLabel === '历史对话 + 锚点文件'
      && isolated.lineage.workspaceMode === 'isolated_at_anchor'
      && typeof isolatedPath === 'string'
      && path.isAbsolute(isolatedPath)
      && isolatedPath !== workspaceRoot
      && isolatedPath.startsWith(path.join(input.dataDir, 'session-fork-worktrees')),
    'isolated_at_anchor advertises a distinct durable worktree',
    { workspaceLabel: isolated.workspaceLabel, isolatedPath },
  );
  const isolatedManifest = await fileManifest(isolatedPath!);
  requireCheck(
    manifestDigest(isolatedManifest) === manifestDigest(anchorManifest),
    'isolated worktree reconstructs anchor bytes instead of current files',
    { anchorManifest, isolatedManifest, currentManifest },
  );
  requireCheck(
    !(await fileManifest(isolatedPath!)).some((entry) => entry.path === 'current-only.txt'),
    'current-only file is absent from isolated anchor worktree',
  );
  requireCheck(
    manifestDigest(await fileManifest(workspaceRoot)) === manifestDigest(sourceFilesBeforeFork),
    'shared and isolated Fork leave every source workspace file byte unchanged',
  );
  const sourceAfterFork = readSourceDatabaseSnapshot(dbPath, source.id);
  requireCheck(
    sourceAfterFork.digest === sourceBeforeFork.digest,
    'Fork leaves the source session row and source message rows byte-stable',
    { before: sourceBeforeFork.digest, after: sourceAfterFork.digest },
  );

  const lineage = await domain<SessionForkLineageSummary>(server, 'getForkLineage', {
    sessionId: isolated.childSession.id,
  });
  const children = await domain<SessionForkLineageSummary[]>(server, 'listForkChildren', {
    sessionId: source.id,
  });
  requireCheck(
    lineage.forkId === isolated.lineage.forkId
      && children.filter((child) => child.childSessionId === shared.childSession.id).length === 1
      && children.filter((child) => child.childSessionId === isolated.childSession.id).length === 1,
    'parent/child lineage is readable through the public domain surface',
    { lineage, children },
  );

  const detached = await domain<SessionExportEnvelopeV2>(server, 'exportSessionFork', {
    sessionId: isolated.childSession.id,
    exportId: 'acceptance-isolated-export',
    mode: 'detached_child',
  });
  const portableWorkspace = detached.sessions.find(
    (session) => session.id === isolated.childSession.id,
  )?.workspace;
  requireCheck(
    portableWorkspace?.mode === 'isolated_at_anchor'
      && portableWorkspace.isolatedAnchor?.baseCommit === baseCommit
      && Boolean(portableWorkspace.isolatedAnchor?.diffDigest)
      && Boolean(portableWorkspace.isolatedAnchor?.untrackedManifestDigest)
      && (portableWorkspace.isolatedAnchor?.pathMappings.length ?? 0) > 0,
    'portable isolated evidence exposes base commit, diff, untracked manifest, and path mapping',
    portableWorkspace,
  );

  const sourceProjectId = source.projectId;
  requireCheck(
    typeof sourceProjectId === 'string' && sourceProjectId.length > 0,
    'Fork source is bound to one canonical Project before portability import',
    { sourceProjectId },
  );
  const subtree = await domain<SessionExportEnvelopeV2>(server, 'exportSessionFork', {
    sessionId: source.id,
    exportId: 'acceptance-subtree-export',
    mode: 'subtree',
  });
  const importRequest = {
    envelope: subtree,
    targetProjectId: sourceProjectId,
    namespace: 'acceptance-device-b',
    allowProjectRemap: false,
  };
  const imported = await domain<ImportSessionForkResponse>(
    server,
    'importSessionFork',
    importRequest,
  );
  const repeatedImport = await domain<ImportSessionForkResponse>(
    server,
    'importSessionFork',
    importRequest,
  );
  const importedIsolatedId = imported.sessionIdMap[isolated.childSession.id];
  requireCheck(
    typeof importedIsolatedId === 'string'
      && imported.importId === repeatedImport.importId
      && canonicalJson(imported.sessionIdMap) === canonicalJson(repeatedImport.sessionIdMap),
    'portable subtree import is idempotent and maps the isolated child once',
    { imported, repeatedImport, importedIsolatedId },
  );
  const importedIsolated = await domain<Session>(server, 'load', {
    sessionId: importedIsolatedId,
  });
  requireCheck(
    importedIsolated.readOnly === false
      && importedIsolated.projectId === sourceProjectId
      && typeof importedIsolated.workingDirectory === 'string'
      && importedIsolated.workingDirectory !== workspaceRoot
      && manifestDigest(await fileManifest(importedIsolated.workingDirectory))
        === manifestDigest(anchorManifest),
    'Web import publishes a runnable durable isolated workspace with exact anchor bytes',
    {
      importedIsolatedId,
      workingDirectory: importedIsolated.workingDirectory,
      readOnly: importedIsolated.readOnly,
      projectId: importedIsolated.projectId,
    },
  );
  const importedLineage = await domain<SessionForkLineageSummary>(server, 'getForkLineage', {
    sessionId: importedIsolatedId,
  });
  requireCheck(
    importedLineage.parentSessionId === imported.sessionIdMap[source.id]
      && importedLineage.sourceAnchorMessageId === imported.messageIdMap.a2,
    'portable import preserves remapped parent/child lineage and anchor provenance',
    importedLineage,
  );
  const reexported = await domain<SessionExportEnvelopeV2>(server, 'exportSessionFork', {
    sessionId: importedIsolatedId,
    exportId: 'acceptance-imported-isolated-reexport',
    mode: 'detached_child',
  });
  const reexportedWorkspace = reexported.sessions
    .find((session) => session.id === importedIsolatedId)
    ?.workspace;
  requireCheck(
    reexportedWorkspace?.mode === 'isolated_at_anchor'
      && reexportedWorkspace.isolatedAnchor?.content.payloadDigest
        === portableWorkspace?.isolatedAnchor?.content.payloadDigest
      && reexportedWorkspace.isolatedAnchor?.baseCommit === baseCommit,
    'published imported isolated workspace can be re-exported with identical portable evidence',
    reexportedWorkspace,
  );
  requireCheck(
    manifestDigest(await fileManifest(workspaceRoot)) === manifestDigest(sourceFilesBeforeFork)
      && readSourceDatabaseSnapshot(dbPath, source.id).digest === sourceAfterFork.digest,
    'portable import and re-export leave the original source rows and workspace byte-stable',
  );

  const childSidecars = [
    shared.childSession.id,
    isolated.childSession.id,
  ].map((sessionId) => ({
    sessionId,
    counts: readSessionSidecarCounts(dbPath, sessionId),
  }));
  requireCheck(
    childSidecars.every(({ counts }) => Object.values(counts).every((count) => count === 0)),
    'Fork child starts without Todo, queue, lease, approval/execution, or runtime sidecars',
    childSidecars,
  );
  requireCheck(
    shared.childSession.projectId === source.projectId
      && isolated.childSession.projectId === source.projectId
      && shared.childSession.modelConfig.provider === source.modelConfig.provider
      && shared.childSession.modelConfig.model === source.modelConfig.model
      && isolated.childSession.modelConfig.provider === source.modelConfig.provider
      && isolated.childSession.modelConfig.model === source.modelConfig.model
      && shared.childSession.memoryMode === source.memoryMode
      && isolated.childSession.memoryMode === source.memoryMode,
    'Fork children inherit Project, durable model identity, and memory preferences',
    {
      source: {
        projectId: source.projectId,
        modelConfig: source.modelConfig,
        memoryMode: source.memoryMode,
      },
      shared: {
        projectId: shared.childSession.projectId,
        modelConfig: shared.childSession.modelConfig,
        memoryMode: shared.childSession.memoryMode,
      },
      isolated: {
        projectId: isolated.childSession.projectId,
        modelConfig: isolated.childSession.modelConfig,
        memoryMode: isolated.childSession.memoryMode,
      },
    },
  );

  let countsBefore = readDatabaseCounts(dbPath);
  await expectDomainFailure(server, 'fork', {
    sourceSessionId: source.id,
    anchorAssistantMessageId: 'u2',
    idempotencyKey: 'acceptance-illegal-user-anchor',
    workspaceMode: 'shared_current',
  }, 'ANCHOR_NOT_COMPLETED_ASSISTANT');
  assertCountsEqual(
    countsBefore,
    readDatabaseCounts(dbPath),
    'illegal Fork anchor performs zero database writes',
  );

  const hiddenSource = await createSession(server, 'Hidden anchor source', workspaceRoot);
  const hiddenMessages = conversation(timestamp, 'hidden-');
  await seedMessages(server, hiddenSource.id, hiddenMessages);
  const hiddenRewind = await domain<RewindConversationResult>(server, 'rewindConversation', {
    sessionId: hiddenSource.id,
    anchorUserMessageId: 'hidden-u2',
    idempotencyKey: 'acceptance-hidden-anchor-rewind',
  });
  requireCheck(hiddenRewind.hiddenMessageCount === 3, 'Rewind hides anchor and later messages without deletion');
  countsBefore = readDatabaseCounts(dbPath);
  const hiddenBefore = readSourceDatabaseSnapshot(dbPath, hiddenSource.id);
  await expectDomainFailure(server, 'fork', {
    sourceSessionId: hiddenSource.id,
    anchorAssistantMessageId: 'hidden-a2',
    idempotencyKey: 'acceptance-hidden-fork',
    workspaceMode: 'shared_current',
  }, 'ANCHOR_REWOUND');
  assertCountsEqual(
    countsBefore,
    readDatabaseCounts(dbPath),
    'hidden Fork anchor performs zero database writes',
  );
  requireCheck(
    readSourceDatabaseSnapshot(dbPath, hiddenSource.id).digest === hiddenBefore.digest,
    'hidden anchor rejection leaves source rows unchanged',
  );

  const runningSource = await createSession(server, 'Running source', workspaceRoot);
  const runningMessages = conversation(timestamp, 'running-');
  await seedMessages(server, runningSource.id, runningMessages.slice(0, 2));
  await requestJson(server, 'POST', '/api/dev/agent-loop-stub', { sessionId: runningSource.id });
  countsBefore = readDatabaseCounts(dbPath);
  const runningBefore = readSourceDatabaseSnapshot(dbPath, runningSource.id);
  await expectDomainFailure(server, 'fork', {
    sourceSessionId: runningSource.id,
    anchorAssistantMessageId: 'running-a1',
    idempotencyKey: 'acceptance-running-fork',
    workspaceMode: 'shared_current',
  }, 'SESSION_RUNNING');
  await expectDomainFailure(server, 'rewindConversation', {
    sessionId: runningSource.id,
    anchorUserMessageId: 'running-u1',
    idempotencyKey: 'acceptance-running-rewind',
  }, 'SESSION_RUNNING');
  assertCountsEqual(
    countsBefore,
    readDatabaseCounts(dbPath),
    'running Fork/Rewind rejection performs zero database writes',
  );
  requireCheck(
    readSourceDatabaseSnapshot(dbPath, runningSource.id).digest === runningBefore.digest,
    'running Fork/Rewind rejection leaves source rows unchanged',
  );
  await requestJson(
    server,
    'DELETE',
    `/api/dev/agent-loop-stub/${encodeURIComponent(runningSource.id)}`,
  );

  const rewindSource = await createSession(server, 'Rewind source', workspaceRoot);
  const rewindMessages = conversation(timestamp, 'rewind-');
  await seedMessages(server, rewindSource.id, rewindMessages);
  const rewindUi = seedRewindGenerativeUi(
    dbPath,
    rewindSource.id,
    'rewind-a2',
    timestamp,
  );
  const workspaceBeforeRewind = await fileManifest(workspaceRoot);
  const rewindContentDigest = readMessageContentDigest(dbPath, rewindSource.id);
  const beforeRewindCount = readSourceDatabaseSnapshot(dbPath, rewindSource.id).messages.length;
  const rewind = await domain<RewindConversationResult>(server, 'rewindConversation', {
    sessionId: rewindSource.id,
    anchorUserMessageId: 'rewind-u2',
    idempotencyKey: 'acceptance-rewind-u2',
  });
  requireCheck(
    rewind.hiddenMessageCount === 3
      && rewind.activeMessages.map((message) => message.id).join(',') === 'rewind-u1,rewind-a1'
      && rewind.workspaceChanged === false
      && rewind.filesRestored === 0
      && rewind.filesDeleted === 0,
    'Rewind uses soft visibility and never restores files implicitly',
    rewind,
  );
  const hiddenRewindUi = readRewindGenerativeUi(
    dbPath,
    rewindUi.instanceId,
    rewindUi.manifestId,
  );
  requireCheck(
    hiddenRewindUi.instance?.status === 'hidden'
      && hiddenRewindUi.instance.hidden_by_rewind_id === rewind.rewindId
      && hiddenRewindUi.manifest?.status === 'invalidated'
      && hiddenRewindUi.manifest.invalidation_reason === 'SOURCE_REWOUND',
    'Rewind hides generated UI with an exact rewind marker and revokes execution authority',
    hiddenRewindUi,
  );
  const repeatedRewind = await domain<RewindConversationResult>(server, 'rewindConversation', {
    sessionId: rewindSource.id,
    anchorUserMessageId: 'rewind-u2',
    idempotencyKey: 'acceptance-rewind-u2',
  });
  requireCheck(
    repeatedRewind.rewindId === rewind.rewindId,
    'repeated Rewind idempotency key returns the same audit record',
    { first: rewind.rewindId, repeated: repeatedRewind.rewindId },
  );
  requireCheck(
    readSourceDatabaseSnapshot(dbPath, rewindSource.id).messages.length === beforeRewindCount
      && readMessageContentDigest(dbPath, rewindSource.id) === rewindContentDigest,
    'Rewind retains all message rows and exact message payload bytes',
  );
  requireCheck(
    manifestDigest(await fileManifest(workspaceRoot)) === manifestDigest(workspaceBeforeRewind),
    'Rewind leaves workspace files byte-stable',
  );
  const rewindRows = readRewindRows(dbPath, rewindSource.id);
  requireCheck(
    rewindRows.length === 1
      && rewindRows[0].id === rewind.rewindId
      && rewindRows[0].status === 'completed'
      && Number(rewindRows[0].files_restored) === 0
      && Number(rewindRows[0].files_deleted) === 0,
    'Rewind audit record is durable and file counters remain zero',
    rewindRows,
  );

  const invalidRewindSource = await createSession(server, 'Invalid Rewind source', workspaceRoot);
  const invalidRewindMessages = conversation(timestamp, 'invalid-');
  await seedMessages(server, invalidRewindSource.id, invalidRewindMessages.slice(0, 2));
  countsBefore = readDatabaseCounts(dbPath);
  const invalidRewindBefore = readSourceDatabaseSnapshot(dbPath, invalidRewindSource.id);
  await expectDomainFailure(server, 'rewindConversation', {
    sessionId: invalidRewindSource.id,
    anchorUserMessageId: 'invalid-a1',
    idempotencyKey: 'acceptance-invalid-rewind',
  }, 'INVALID_ANCHOR');
  assertCountsEqual(
    countsBefore,
    readDatabaseCounts(dbPath),
    'illegal Rewind anchor performs zero database writes',
  );
  requireCheck(
    readSourceDatabaseSnapshot(dbPath, invalidRewindSource.id).digest === invalidRewindBefore.digest,
    'illegal Rewind anchor leaves source rows unchanged',
  );

  const desktopSource = await createSession(server, 'Desktop IPC source', workspaceRoot);
  await seedMessages(server, desktopSource.id, conversation(timestamp, 'desktop-'));

  return {
    result: {
      sourceSessionId: source.id,
      sharedChildId: shared.childSession.id,
      isolatedChildId: isolated.childSession.id,
      isolatedWorktree: isolatedPath,
      sharedForkId: shared.lineage.forkId,
      isolatedForkId: isolated.lineage.forkId,
      sourceDatabaseDigest: sourceAfterFork.digest,
      sourceFileManifestDigest: manifestDigest(sourceFilesBeforeFork),
      stablePrefixSourceIds: shared.messageMappings.map((mapping) => mapping.sourceMessageId),
      portableWorkspace,
      portabilityImport: {
        importId: imported.importId,
        rootSessionId: imported.rootSessionId,
        importedIsolatedId,
        importedIsolatedWorktree: importedIsolated.workingDirectory,
        reexportedPayloadDigest:
          reexportedWorkspace?.isolatedAnchor?.content.payloadDigest,
      },
    },
    rewind: {
      sessionId: rewindSource.id,
      rewindId: rewind.rewindId,
      contentDigest: rewindContentDigest,
      ...rewindUi,
    },
    desktopSessionId: desktopSource.id,
    sourceSessionId: source.id,
    sharedChildId: shared.childSession.id,
    isolatedChildId: isolated.childSession.id,
    anchorManifest,
    currentManifest,
  };
}

async function verifyRestartAndRestore(input: {
  server: StartedServer;
  dbPath: string;
  sourceSessionId: string;
  sharedChildId: string;
  isolatedChildId: string;
  rewind: {
    sessionId: string;
    rewindId: string;
    contentDigest: string;
    instanceId: string;
    manifestId: string;
  };
  anchorManifest: FileManifestEntry[];
}): Promise<Record<string, unknown>> {
  const sourceChildren = await domain<SessionForkLineageSummary[]>(
    input.server,
    'listForkChildren',
    { sessionId: input.sourceSessionId },
  );
  requireCheck(
    sourceChildren.some((child) => child.childSessionId === input.sharedChildId)
      && sourceChildren.some((child) => child.childSessionId === input.isolatedChildId),
    'Fork lineage survives a real app-host restart',
    sourceChildren,
  );
  const isolatedSession = await domain<Session>(input.server, 'load', {
    sessionId: input.isolatedChildId,
  });
  requireCheck(
    typeof isolatedSession.workingDirectory === 'string'
      && manifestDigest(await fileManifest(isolatedSession.workingDirectory))
        === manifestDigest(input.anchorManifest),
    'durable isolated worktree survives restart with anchor bytes',
    { workingDirectory: isolatedSession.workingDirectory },
  );
  const activeAfterRestart = await domain<Message[]>(input.server, 'getMessages', {
    sessionId: input.rewind.sessionId,
  });
  requireCheck(
    activeAfterRestart.map((message) => message.id).join(',') === 'rewind-u1,rewind-a1',
    'soft-hidden Rewind projection survives restart',
    activeAfterRestart.map((message) => message.id),
  );
  const restored = await domain<RestoreConversationRewindResult>(
    input.server,
    'restoreConversationRewind',
    {
      sessionId: input.rewind.sessionId,
      rewindId: input.rewind.rewindId,
    },
  );
  requireCheck(
    restored.restoredMessageCount === 3
      && restored.activeMessages.map((message) => message.id).join(',')
        === 'rewind-u1,rewind-a1,rewind-u2,rewind-a2,rewind-u3'
      && restored.workspaceChanged === false,
    'explicit Rewind restore recovers the full visible projection after restart',
    restored,
  );
  requireCheck(
    readMessageContentDigest(input.dbPath, input.rewind.sessionId) === input.rewind.contentDigest,
    'Rewind restore preserves original message payload bytes',
  );
  const restoredRewindUi = readRewindGenerativeUi(
    input.dbPath,
    input.rewind.instanceId,
    input.rewind.manifestId,
  );
  requireCheck(
    restoredRewindUi.instance?.status === 'active'
      && restoredRewindUi.instance.hidden_by_rewind_id === null
      && restoredRewindUi.manifest?.status === 'invalidated'
      && restoredRewindUi.manifest.invalidation_reason === 'SOURCE_REWOUND',
    'explicit restore recovers UI visibility without reviving invalidated authority',
    restoredRewindUi,
  );
  const rows = readRewindRows(input.dbPath, input.rewind.sessionId);
  requireCheck(
    rows.length === 1
      && rows[0].status === 'restored'
      && typeof rows[0].restored_at === 'number',
    'restore updates the durable Rewind audit lifecycle',
    rows,
  );
  return {
    forkChildren: sourceChildren.map((child) => child.childSessionId),
    isolatedWorkingDirectory: isolatedSession.workingDirectory,
    rewindId: restored.rewindId,
    restoredMessageCount: restored.restoredMessageCount,
    restoredGenerativeUi: restoredRewindUi,
    rewindAudit: rows,
  };
}

async function runDesktopIpcAcceptance(input: {
  dataDir: string;
  dbPath: string;
  sessionId: string;
  workspaceRoot: string;
  fakeHome: string;
  fakeBin: string;
}): Promise<Record<string, unknown>> {
  process.env.CODE_AGENT_DATA_DIR = input.dataDir;
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_RENDERER_HOT_UPDATE = 'false';

  const [
    { initDatabase },
    { AgentAppServiceImpl },
    { registerSessionHandlers },
    { IPC_DOMAINS },
  ] = await Promise.all([
    import('../../src/host/services/core/databaseService'),
    import('../../src/host/app/agentAppService'),
    import('../../src/host/ipc/session.ipc'),
    import('../../src/shared/ipc/domains'),
  ]);
  const database = await initDatabase();
  const runtimeContexts = new Map<string, Message[]>();
  const taskManager = {
    getSessionState: () => ({ status: 'idle' }),
    setSessionContext: (sessionId: string, messages: Message[]) => {
      runtimeContexts.set(sessionId, structuredClone(messages));
    },
  };
  const appService = new AgentAppServiceImpl(
    () => taskManager as never,
    () => null,
    () => null,
    () => {},
  );
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(channel, handler);
    },
    on() {},
    once() {},
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    removeAllListeners() {},
  };
  registerSessionHandlers(ipcMain as never, () => appService);
  const handler = handlers.get(IPC_DOMAINS.SESSION);
  if (!handler) throw new Error('Desktop session IPC handler was not registered');
  const invoke = async <T>(action: string, payload: unknown): Promise<T> => {
    const response = await handler(null, { action, payload }) as IpcResponse<T>;
    if (!response.success) {
      throw new DomainCallError(
        response.error?.code ?? 'UNKNOWN',
        response.error?.message ?? `${action} failed`,
      );
    }
    return response.data as T;
  };

  try {
    const fork = await invoke<CreateSessionForkResult>('fork', {
      sourceSessionId: input.sessionId,
      anchorAssistantMessageId: 'desktop-a2',
      idempotencyKey: 'acceptance-desktop-fork',
      workspaceMode: 'shared_current',
    });
    requireCheck(
      fork.copiedMessageCount === 4
        && runtimeContexts.get(fork.childSession.id)?.length === 4,
      'Desktop IPC executes Fork through AgentAppService and hydrates child runtime context',
      {
        childSessionId: fork.childSession.id,
        copiedMessageCount: fork.copiedMessageCount,
        runtimeContextCount: runtimeContexts.get(fork.childSession.id)?.length,
      },
    );
    const rewind = await invoke<RewindConversationResult>('rewindConversation', {
      sessionId: input.sessionId,
      anchorUserMessageId: 'desktop-u2',
      idempotencyKey: 'acceptance-desktop-rewind',
    });
    requireCheck(
      rewind.hiddenMessageCount === 3
        && runtimeContexts.get(input.sessionId)?.length === 2
        && rewind.workspaceChanged === false,
      'Desktop IPC executes history-only Rewind through AgentAppService',
      rewind,
    );
    const restored = await invoke<RestoreConversationRewindResult>(
      'restoreConversationRewind',
      {
        sessionId: input.sessionId,
        rewindId: rewind.rewindId,
      },
    );
    requireCheck(
      restored.restoredMessageCount === 3
        && runtimeContexts.get(input.sessionId)?.length === 5
        && restored.workspaceChanged === false,
      'Desktop IPC executes explicit Rewind restore through AgentAppService',
      restored,
    );
    const externalProcess = await runExternalEngineProcessAcceptance({
      database,
      dbPath: input.dbPath,
      templateSessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      fakeHome: input.fakeHome,
      fakeBin: input.fakeBin,
      recordCheck: requireCheck,
    });
    return {
      sourceSessionId: input.sessionId,
      childSessionId: fork.childSession.id,
      forkId: fork.lineage.forkId,
      rewindId: rewind.rewindId,
      restoredMessageCount: restored.restoredMessageCount,
      externalProcess,
    };
  } finally {
    database.close();
  }
}

async function verifyShellManifest(): Promise<Record<string, unknown>> {
  const [
    { getShellCapabilitiesManifest },
    { makeShellCapabilityId },
    { IPC_DOMAINS },
  ] = await Promise.all([
    import('../../src/host/shellCapabilities'),
    import('../../src/shared/contract/shellCapabilities'),
    import('../../src/shared/ipc/domains'),
  ]);
  const manifest = getShellCapabilitiesManifest('acceptance', new Date(0).toISOString());
  const requiredActions = [
    'fork',
    'getForkLineage',
    'listForkChildren',
    'rewindConversation',
    'restoreConversationRewind',
    'restoreWorkspaceFilesAtCheckpoint',
  ];
  const advertised = new Set(manifest.capabilities.map((capability) => capability.id));
  const requiredIds = requiredActions.map((action) => (
    makeShellCapabilityId(IPC_DOMAINS.SESSION, action)
  ));
  requireCheck(
    requiredIds.every((id) => advertised.has(id)),
    'Shell capability manifest advertises the same Fork/Rewind domain actions',
    requiredIds,
  );
  return {
    schemaVersion: manifest.schemaVersion,
    requiredIds,
    advertised: requiredIds.filter((id) => advertised.has(id)),
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const options = parseOptions(process.argv.slice(2));
  const build = await readBuildFingerprint(
    options.allowStaleBuild,
    options.requireCleanHead,
    options.requireFullBuild,
  );
  const root = options.evidenceDir
    ? path.resolve(options.evidenceDir)
    : await mkdtemp(path.join(os.tmpdir(), 'neo-session-fork-acceptance-'));
  const dataDir = path.join(root, 'data');
  const fakeHome = path.join(root, 'home');
  const workspaceRoot = path.join(root, 'workspace');
  const evidenceDir = path.join(root, 'evidence');
  const dbPath = path.join(dataDir, 'code-agent.db');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
    mkdir(evidenceDir, { recursive: true }),
  ]);

  let server: StartedServer | null = null;
  let report: AcceptanceReport | null = null;
  const networkAudits: NetworkAudit[] = [];
  try {
    const baseCommit = await initializeWorkspace(workspaceRoot);
    server = await startServer(dataDir, fakeHome, workspaceRoot);
    const web = await runWebAcceptance({
      server,
      dataDir,
      dbPath,
      workspaceRoot,
      baseCommit,
    });
    await stopServer(server);
    networkAudits.push(await verifyNetworkAudit(server, 'initial'));
    server = null;

    server = await startServer(dataDir, fakeHome, workspaceRoot);
    const restart = await verifyRestartAndRestore({
      server,
      dbPath,
      sourceSessionId: web.sourceSessionId,
      sharedChildId: web.sharedChildId,
      isolatedChildId: web.isolatedChildId,
      rewind: web.rewind,
      anchorManifest: web.anchorManifest,
    });
    await stopServer(server);
    networkAudits.push(await verifyNetworkAudit(server, 'restarted'));
    server = null;

    const externalEnvironment = await prepareExternalEngineAcceptanceEnvironment({
      evidenceRoot: evidenceDir,
      fakeHome,
    });
    const desktop = await runDesktopIpcAcceptance({
      dataDir,
      dbPath,
      sessionId: web.desktopSessionId,
      workspaceRoot,
      fakeHome,
      fakeBin: externalEnvironment.fakeBin,
    });
    const shell = await verifyShellManifest();
    const finalCounts = readDatabaseCounts(dbPath);
    const workspaceEvidence = readWorkspaceEvidenceRows(dbPath, web.sourceSessionId);
    const finalSourceSnapshot = readSourceDatabaseSnapshot(dbPath, web.sourceSessionId);
    const finalCurrentManifest = await fileManifest(workspaceRoot);

    report = {
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      repoRoot,
      dataDir,
      workspaceRoot,
      build,
      checks,
      web: {
        ...web.result,
        restart,
      },
      desktop,
      shell,
      network: {
        policy: 'loopback-only',
        appHosts: networkAudits,
        blockedExternalConnectionAttempts: networkAudits.flatMap(
          (audit) => audit.blockedExternalConnectionAttempts,
        ),
      },
      database: {
        dbPath,
        counts: finalCounts,
        sourceSnapshotDigest: finalSourceSnapshot.digest,
        workspaceEvidence,
      },
      files: {
        baseCommit,
        anchorManifest: web.anchorManifest,
        anchorManifestDigest: manifestDigest(web.anchorManifest),
        currentManifest: finalCurrentManifest,
        currentManifestDigest: manifestDigest(finalCurrentManifest),
      },
    };

    const reportPath = path.join(evidenceDir, 'session-fork-smoke-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      checks: checks.length,
      build,
      reportPath,
      kept: options.keep || Boolean(options.evidenceDir),
      web: report.web,
      desktop: report.desktop,
      shell: report.shell,
      network: report.network,
    }, null, 2));
  } catch (error) {
    if (server) {
      console.error(server.output());
    }
    throw error;
  } finally {
    if (server) await stopServer(server).catch(() => undefined);
    if (!options.keep && !options.evidenceDir) {
      await rm(root, { recursive: true, force: true });
    } else if (report) {
      console.log(`Evidence kept at ${root}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
