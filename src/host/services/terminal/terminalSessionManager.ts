// ============================================================================
// TerminalSessionManager — 会话级长生命周期交互 shell（用户 + Agent 共享同一个 PTY）
//
// 与 tools/shell/ptyExecutor.ts 的关系：**只共用 node-pty，不共用生命周期语义**。
// ptyExecutor 是给一次性工具调用用的：10 分钟硬超时 + 每分钟扫描 kill 超时会话。
// 那套语义搬到这里会把用户挂了半天的 ssh/登录态 CLI 直接杀掉，所以本模块：
//   - 不设 maxRuntime、不注册周期性 kill 扫描；只在 app 退出 / 会话删除 / 用户主动
//     关闭时 dispose；
//   - shell 以交互模式启动（不带 -c），用户敲什么就是什么；
//   - 输出进 ring buffer，供重新挂载（切回视图/切回会话）和 Agent 的 terminal_read 共用
//     同一份快照——两个读者看到的是同一个终端，这是本批「共享 PTY」的全部意义。
// ============================================================================

import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getUserConfigDir } from '../../config/configPaths';
import { resolveWindowsShell } from '../../tools/shell/platformShell';
import { createLogger } from '../infra/logger';

const logger = createLogger('TerminalSession');

/** ring buffer 上限：够翻回去看清刚才发生了什么，又不至于把 host 内存吃穿 */
const MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalSnapshot {
  sessionId: string;
  /** 原始输出（含 ANSI）——渲染端要靠它复原光标/颜色，禁止在这里 strip */
  data: string;
  cols: number;
  rows: number;
  alive: boolean;
  shell: string;
  cwd: string;
  startedAt: number;
}

interface TerminalSession {
  sessionId: string;
  pty: pty.IPty;
  chunks: string[];
  bufferBytes: number;
  cols: number;
  rows: number;
  alive: boolean;
  shell: string;
  cwd: string;
  startedAt: number;
}

const sessions = new Map<string, TerminalSession>();

type OutputListener = (sessionId: string, data: string) => void;
const outputListeners = new Set<OutputListener>();

export function onTerminalOutput(listener: OutputListener): () => void {
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

function emitOutput(sessionId: string, data: string): void {
  for (const listener of outputListeners) {
    try {
      listener(sessionId, data);
    } catch (err) {
      logger.warn('terminal output listener threw', { sessionId, err });
    }
  }
}

function appendToBuffer(session: TerminalSession, data: string): void {
  session.chunks.push(data);
  session.bufferBytes += data.length;
  while (session.bufferBytes > MAX_BUFFER_BYTES && session.chunks.length > 1) {
    const dropped = session.chunks.shift();
    session.bufferBytes -= dropped?.length ?? 0;
  }
}

// ----------------------------------------------------------------------------
// 孤儿 PTY 收割
//
// app 被强杀（SIGKILL / 崩溃 / 覆盖安装）时 onExit 不会跑，PTY 子进程会活下来变孤儿。
// 每次 create/dispose 都把活着的 pid 落盘，启动时读回来收割。
// pid 会被系统复用，所以杀之前必须核对 comm 确实是我们记下的那个 shell——
// 核不了（win32 无 ps）就不杀，宁可漏收一个也不能误杀用户的进程。
// ----------------------------------------------------------------------------

interface PersistedTerminalPid {
  pid: number;
  shell: string;
}

function getPidFilePath(): string {
  return path.join(getUserConfigDir(), 'terminal-pids.json');
}

function persistLivePids(): void {
  const live: PersistedTerminalPid[] = [];
  for (const session of sessions.values()) {
    if (session.alive) live.push({ pid: session.pty.pid, shell: session.shell });
  }
  try {
    fs.mkdirSync(path.dirname(getPidFilePath()), { recursive: true });
    fs.writeFileSync(getPidFilePath(), JSON.stringify(live));
  } catch (err) {
    logger.warn('failed to persist terminal pids', { err });
  }
}

function parsePersistedPids(raw: unknown): PersistedTerminalPid[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { pid, shell } = entry as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof shell !== 'string') return [];
    return [{ pid, shell }];
  });
}

/** pid 当前是否真的还是我们记下的那个 shell（POSIX：核 comm；win32：核不了返回 false） */
function pidStillMatchesShell(pid: number, shell: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
    if (!comm) return false;
    return path.basename(comm) === path.basename(shell);
  } catch {
    return false;
  }
}

/** 启动时调用：杀掉上次进程留下的孤儿 PTY。返回实际收割掉的个数。 */
export function reapOrphanTerminals(): number {
  let raw: unknown;
  try {
    if (!fs.existsSync(getPidFilePath())) return 0;
    raw = JSON.parse(fs.readFileSync(getPidFilePath(), 'utf-8')) as unknown;
  } catch (err) {
    logger.warn('failed to read terminal pid file', { err });
    return 0;
  }

  let reaped = 0;
  for (const entry of parsePersistedPids(raw)) {
    if (!pidStillMatchesShell(entry.pid, entry.shell)) continue;
    try {
      process.kill(entry.pid, 'SIGKILL');
      reaped += 1;
      logger.info('reaped orphan terminal pty', { pid: entry.pid });
    } catch (err) {
      logger.warn('failed to reap orphan terminal pty', { pid: entry.pid, err });
    }
  }

  try {
    fs.writeFileSync(getPidFilePath(), '[]');
  } catch {
    /* 收割结果落盘失败不影响本次运行 */
  }
  return reaped;
}

// ----------------------------------------------------------------------------
// 生命周期
// ----------------------------------------------------------------------------

export interface OpenTerminalOptions {
  sessionId: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

/** 打开或重新挂载会话终端。已存在且活着 → 直接返回既有快照（同一个 PTY，不新建）。 */
export function openTerminalSession(options: OpenTerminalOptions): TerminalSnapshot {
  const existing = sessions.get(options.sessionId);
  if (existing?.alive) {
    if (options.cols && options.rows) resizeTerminalSession(options.sessionId, options.cols, options.rows);
    return snapshotOf(existing);
  }
  if (existing) sessions.delete(options.sessionId);

  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? resolveWindowsShell() : process.env.SHELL || '/bin/bash';
  // 交互式登录 shell：用户要在这里 `grok login` 之类，rc 文件里的 PATH/别名必须生效。
  const shellArgs = isWindows ? ['-NoLogo'] : ['-i', '-l'];

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: options.cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    ...(isWindows ? { useConpty: true } : {}),
  });

  const session: TerminalSession = {
    sessionId: options.sessionId,
    pty: ptyProcess,
    chunks: [],
    bufferBytes: 0,
    cols,
    rows,
    alive: true,
    shell,
    cwd: options.cwd,
    startedAt: Date.now(),
  };

  ptyProcess.onData((data) => {
    appendToBuffer(session, data);
    emitOutput(session.sessionId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.alive = false;
    const notice = `\r\n\x1b[2m[terminal exited with code ${exitCode}]\x1b[0m\r\n`;
    appendToBuffer(session, notice);
    emitOutput(session.sessionId, notice);
    persistLivePids();
  });

  sessions.set(options.sessionId, session);
  persistLivePids();
  logger.info('terminal session opened', { sessionId: options.sessionId, pid: ptyProcess.pid });
  return snapshotOf(session);
}

export function writeToTerminalSession(sessionId: string, data: string): { ok: boolean; error?: string } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: `No terminal session for ${sessionId}` };
  if (!session.alive) return { ok: false, error: `Terminal session ${sessionId} has exited` };
  try {
    session.pty.write(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 把一段文字直接印进终端画面 + ring buffer，但**不喂给 shell**。
 * Agent 注入命令时的可见回显走这里：用户在自己的终端里必须能看到「Neo 敲了什么」，
 * 而不是凭空冒出一行命令的执行结果。
 */
export function annotateTerminalSession(sessionId: string, text: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  appendToBuffer(session, text);
  emitOutput(sessionId, text);
  return true;
}

export function resizeTerminalSession(sessionId: string, cols: number, rows: number): boolean {
  const session = sessions.get(sessionId);
  if (!session?.alive) return false;
  try {
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    return true;
  } catch (err) {
    logger.warn('terminal resize failed', { sessionId, err });
    return false;
  }
}

export function disposeTerminalSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.alive) {
    try {
      session.pty.kill();
    } catch (err) {
      logger.warn('terminal kill failed', { sessionId, err });
    }
  }
  session.alive = false;
  sessions.delete(sessionId);
  persistLivePids();
  return true;
}

export function disposeAllTerminalSessions(): void {
  for (const sessionId of [...sessions.keys()]) disposeTerminalSession(sessionId);
}

// app 退出时收干净——本模块没有周期性超时清理，这里是唯一的兜底出口。
import('../infra/gracefulShutdown')
  .then(({ onShutdown }) => {
    onShutdown('terminal/sessionManager.dispose', async () => {
      disposeAllTerminalSessions();
    });
  })
  .catch(() => { /* shutdown infra 不可用：pid 文件仍在，下次启动靠孤儿收割兜底 */ });

// ----------------------------------------------------------------------------
// 读取
// ----------------------------------------------------------------------------

function snapshotOf(session: TerminalSession): TerminalSnapshot {
  return {
    sessionId: session.sessionId,
    data: session.chunks.join(''),
    cols: session.cols,
    rows: session.rows,
    alive: session.alive,
    shell: session.shell,
    cwd: session.cwd,
    startedAt: session.startedAt,
  };
}

export function getTerminalSnapshot(sessionId: string): TerminalSnapshot | null {
  const session = sessions.get(sessionId);
  return session ? snapshotOf(session) : null;
}

export function listTerminalSessions(): TerminalSnapshot[] {
  return [...sessions.values()].map((session) => ({ ...snapshotOf(session), data: '' }));
}

export function hasTerminalSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** 测试用：清空全部状态（不 kill，测试里用的是 fake pty） */
export function __resetTerminalSessionsForTest(): void {
  sessions.clear();
  outputListeners.clear();
}
