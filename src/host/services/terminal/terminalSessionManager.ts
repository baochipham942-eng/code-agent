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
// eslint-disable-next-line no-restricted-imports -- platform shell resolution, not a legacy tool impl（同 agent/scriptRuntime/sandbox.ts 先例）
import { killProcessTree, resolveWindowsShell, type KillableChild } from '../../tools/shell/platformShell';
import { SHELL_KILL } from '../../../shared/constants/tools';
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
  /** 程序是否切到了备用屏（全屏 TUI）。见 updateAlternateScreen。 */
  altScreen: boolean;
  /**
   * 供 killProcessTree 使用的句柄视图（懒建、随会话长存）。
   * **不能每次现造**：整树退出边界记在 WeakSet 里、按对象身份认，现造的话防 pid 复用就失效。
   */
  killable?: KillableChild;
  /** onExit 回填的退出码，给上面那个视图当实时值读。 */
  exitCode?: number;
}

const sessions = new Map<string, TerminalSession>();

/**
 * 备用屏（alternate screen buffer）开关序列。全屏 TUI（Codex CLI / vim / less / htop…）
 * 启动时切进去、退出时切回来，切进去之后整屏由它自己重绘。
 * 1049 是现代终端的写法，47 / 1047 是老程序留下的两种旧写法，一并认。
 */
const ALT_SCREEN_ENTER = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'] as const;
const ALT_SCREEN_LEAVE = ['\x1b[?1049l', '\x1b[?1047l', '\x1b[?47l'] as const;

/** 一组序列在 data 里最后一次出现的位置；都没出现返回 -1。 */
function lastIndexOfAny(data: string, needles: readonly string[]): number {
  let last = -1;
  for (const needle of needles) {
    const at = data.lastIndexOf(needle);
    if (at > last) last = at;
  }
  return last;
}

/**
 * 从一段 PTY 输出里更新备用屏状态：取最后一次开关为准（同一段里可能既进又出）。
 * 用字符串查找而不是正则——正则字面量里写 \x1b 会撞 no-control-regex，
 * 而这里要找的本来就是固定序列，indexOf 够用也更直白。
 *
 * ponytail: 只认落在单个 chunk 内的完整序列。理论上转义序列可能被切在两个 chunk
 * 中间，此时这一次切换会被漏掉。代价只是回显多印/少印一行（不影响注入本身），
 * 真出问题再上跨 chunk 的残尾拼接。
 */
function updateAlternateScreen(session: TerminalSession, data: string): void {
  const entered = lastIndexOfAny(data, ALT_SCREEN_ENTER);
  const left = lastIndexOfAny(data, ALT_SCREEN_LEAVE);
  if (entered < 0 && left < 0) return;
  session.altScreen = entered > left;
}

type OutputListener = (sessionId: string, data: string) => void;
const outputListeners = new Set<OutputListener>();

export function onTerminalOutput(listener: OutputListener): () => void {
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

type RevealListener = (sessionId: string) => void;
const revealListeners = new Set<RevealListener>();

export function onTerminalReveal(listener: RevealListener): () => void {
  revealListeners.add(listener);
  return () => revealListeners.delete(listener);
}

/**
 * 请求右栏把终端亮出来。只表达意图，不决定要不要真切过去——
 * 抢焦点的节制（每轮一次 / 用户切走不抢回）在 renderer 的 surfaceIntent 那一套里，
 * 这里再判一次就是两处产品决策点。
 */
export function requestTerminalReveal(sessionId: string): void {
  for (const listener of revealListeners) {
    try {
      listener(sessionId);
    } catch (err) {
      logger.warn('terminal reveal listener threw', { sessionId, err });
    }
  }
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
// 每次 create/dispose 都把活着的 pid 落盘，启动时读回来收割。杀之前两道核对，缺一不可：
//   1. 记账的那个 host 进程确实已经死了——同一个 data dir 可能被两个 host 同时用
//      （已知问题，互斥锁另有工单），不核这条，后起的 host 会把先起那个正在用的终端全杀了；
//   2. pid 现在确实还是我们记下的那个 shell——pid 会被系统复用，
//      核不了（win32 无 ps）就不杀，宁可漏收一个孤儿也不能误杀用户的进程。
// ----------------------------------------------------------------------------

interface PersistedTerminalPid {
  pid: number;
  shell: string;
  /** 开这个 PTY 的 host 进程；它还活着就说明这不是孤儿，是别人正在用的。 */
  ownerPid: number;
}

function getPidFilePath(): string {
  return path.join(getUserConfigDir(), 'terminal-pids.json');
}

function persistLivePids(): void {
  const live: PersistedTerminalPid[] = [];
  for (const session of sessions.values()) {
    if (session.alive) live.push({ pid: session.pty.pid, shell: session.shell, ownerPid: process.pid });
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
    const { pid, shell, ownerPid } = entry as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof shell !== 'string') return [];
    // ownerPid 缺失＝旧版本写的记录，按「没有活着的 owner」处理，继续走 comm 核对。
    return [{ pid, shell, ownerPid: typeof ownerPid === 'number' ? ownerPid : 0 }];
  });
}

/** 进程是否还活着（signal 0 不发信号，只探测存在性）。 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  const survivors: PersistedTerminalPid[] = [];
  for (const entry of parsePersistedPids(raw)) {
    if (entry.ownerPid !== process.pid && isProcessAlive(entry.ownerPid)) {
      // 另一个 host 还活着，这是它正在用的终端，不是孤儿。原样留在账上还给它。
      survivors.push(entry);
      logger.info('skipping terminal pty owned by a live host process', { pid: entry.pid, ownerPid: entry.ownerPid });
      continue;
    }
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
    fs.writeFileSync(getPidFilePath(), JSON.stringify(survivors));
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
    altScreen: false,
  };

  ptyProcess.onData((data) => {
    updateAlternateScreen(session, data);
    appendToBuffer(session, data);
    emitOutput(session.sessionId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.alive = false;
    session.exitCode = exitCode;
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
/**
 * 该会话此刻是不是停在全屏 TUI 里。用于决定注入回显该不该印——
 * 备用屏下印进去的东西会被 TUI 的下一帧整屏重绘擦掉，只留一次闪烁。
 */
export function isTerminalOnAlternateScreen(sessionId: string): boolean {
  return sessions.get(sessionId)?.altScreen === true;
}

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

/**
 * 把 `IPty` 适配成 killProcessTree 要的最小子进程视图（形态同 ptyExecutor.killableView）。
 *
 * node-pty 只给 `pid` 和 `kill(signal?)`，没有 `exitCode`/`signalCode`——退出信息走 `onExit`
 * 回填到会话状态，这里用 getter 暴露成实时值。视图缓存在会话上，因为整树退出边界是按
 * 对象身份记的（WeakSet），每次现造等于没有边界。
 */
function killableView(session: TerminalSession): KillableChild {
  if (!session.killable) {
    session.killable = {
      pid: session.pty.pid,
      kill: (signal?: NodeJS.Signals | number): boolean => {
        // node-pty 的 kill 内部就吞异常，返回值不代表信号送达——判死一律看探活。
        try { session.pty.kill(typeof signal === 'string' ? signal : undefined); } catch { /* 已退出 */ }
        return true;
      },
      get exitCode(): number | null { return session.exitCode ?? null; },
      get signalCode(): NodeJS.Signals | null { return null; },
    };
  }
  return session.killable;
}

/**
 * 这个终端里起出来的、当前还活着的全部子孙进程（不含 shell 自己）。
 *
 * 🔴 为什么按 ppid 现场走树，而不是像 ptyExecutor 那样只按进程组收：
 * 这个子系统起的是**交互 shell**，job control 是开着的，用户敲 `npm run dev &`
 * 会被放进**独立进程组**（实测：孙进程 pgid 41329 ≠ shell pgid 41287），
 * `kill(-shellPid)` 一个都收不到，它们会一直活到用户重启机器。
 * 而 macOS 的 `ps -o sess=` 恒为 0（拿不到 session id），所以只能走 ppid 关系。
 *
 * ponytail: 快照式，只认调用这一刻的树。此后新 fork 出来的孙进程收不到——
 * 但那一刻 shell 已经在被杀了，窗口是毫秒级。真出问题再上 kqueue/PROC_EVENTS。
 */
function descendantPids(rootPid: number): number[] {
  if (process.platform === 'win32' || rootPid <= 0) return [];
  let childrenOf: Map<number, number[]>;
  try {
    childrenOf = new Map();
    const listing = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf-8' });
    for (const line of listing.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
    }
  } catch (err) {
    logger.warn('failed to list processes for terminal teardown', { rootPid, err });
    return [];
  }

  const found: number[] = [];
  const queue = [rootPid];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of childrenOf.get(queue[cursor]) ?? []) {
      if (child === rootPid || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* 已退出 / 无权限 */ }
}

/**
 * 等这批子孙进程确认退出：宽限期内还活着就升级 SIGKILL，到上限记 warn 后放弃（不无限挂住停机）。
 * 时间从 `startedAt` 起算——它与 leader 的宽限期是同一个窗口，不叠加。
 */
async function confirmDescendantsGone(pids: number[], startedAt: number, sessionId: string): Promise<void> {
  if (pids.length === 0) return;
  let escalated = false;
  for (;;) {
    const alive = pids.filter(isProcessAlive);
    if (alive.length === 0) return;
    const elapsed = Date.now() - startedAt;
    if (!escalated && elapsed >= SHELL_KILL.GRACE_MS) {
      escalated = true;
      for (const pid of alive) trySignal(pid, 'SIGKILL');
    } else if (elapsed >= SHELL_KILL.CONFIRM_TIMEOUT_MS) {
      logger.warn('terminal descendants did not exit in time', { sessionId, alive });
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, SHELL_KILL.POLL_INTERVAL_MS); });
  }
}

/**
 * 终止终端会话的 PTY，**并等到整棵树确认退出**（leader 的终止内核与 ptyExecutor 完全同一套）。
 *
 * POSIX 上 node-pty 天生 setsid 自成进程组（实测 `pid == pgid`），组模式无条件成立；
 * `pid > 0` 是闸门——`UnixTerminal` 在 `pty.open()` 路径下把 `_pid` 置 -1，
 * 那样 `process.kill(-pid)` 会打到 init 头上。
 * 比 ptyExecutor 多一步子孙扫尾，理由见 `descendantPids`。
 * 已知降级：win32 没有进程组语义也走不了 ppid 扫尾，「确认退出」只能确认到 shell 自身。
 */
async function terminateTerminalPty(session: TerminalSession): Promise<void> {
  const startedAt = Date.now();
  // 必须在 leader 死之前快照：它一死，子孙就被 reparent 到 launchd/init，ppid 关系断了。
  const descendants = descendantPids(session.pty.pid);
  for (const pid of descendants) trySignal(pid, 'SIGTERM');

  try { session.pty.kill(); } catch (err) { logger.warn('terminal kill failed', { sessionId: session.sessionId, err }); }
  await killProcessTree(killableView(session), { posixGroupKill: session.pty.pid > 0 });
  await confirmDescendantsGone(descendants, startedAt, session.sessionId);
}

/** 关掉一个终端会话。**返回时整组已确认退出**（win32 降级到 shell 自身）。 */
export async function disposeTerminalSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.alive) await terminateTerminalPty(session);
  session.alive = false;
  sessions.delete(sessionId);
  persistLivePids();
  return true;
}

/**
 * 停机收尸用：收掉全部终端会话，逐个等确认退出。返回收掉的会话数。
 *
 * 挂的是 `reapChildProcesses()`（webServer / CLI 停机属主真正会调的那条路），
 * **不是** `gracefulShutdown` 的 `onShutdown` 注册表——那张表的
 * `setupDefaultSignalHandlers()` 产品代码零调用方，挂进去等于没挂（STOP1 已坐实）。
 */
export async function reapTerminalSessions(): Promise<number> {
  const ids = [...sessions.keys()];
  const results = await Promise.all(ids.map(async (sessionId) => {
    try {
      return await disposeTerminalSession(sessionId);
    } catch (err) {
      logger.warn('failed to reap terminal session', { sessionId, err });
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

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

/** 测试用：清空全部状态（不 kill，测试里用的是 fake pty） */
export function __resetTerminalSessionsForTest(): void {
  sessions.clear();
  outputListeners.clear();
  revealListeners.clear();
}
