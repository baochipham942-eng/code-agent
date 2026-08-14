// ============================================================================
// PTY Executor - Manages pseudo-terminal sessions for interactive commands
// ============================================================================

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getUserConfigDir } from '../../config/configPaths';
import { killProcessTree, resolveWindowsShell, WINDOWS_SHELL_ENCODING_PRELUDE, type KillableChild } from './platformShell';

// ============================================================================
// Constants
// ============================================================================

const MAX_PTY_SESSIONS = 10;
const MAX_PTY_OUTPUT = 1024 * 1024; // 1MB per session
const PTY_DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const PTY_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

// ============================================================================
// Types
// ============================================================================

interface PtySessionState {
  sessionId: string;
  pty: pty.IPty;
  output: string[];
  outputFile: string;
  outputStream?: fs.WriteStream;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  maxRuntime: number;
  outputSize: number;
  command: string;
  args: string[];
  exitCode?: number;
  lastReadPosition: number;
  timeout?: NodeJS.Timeout;
  cwd: string;
  ownerSessionId?: string;
  toolCallId?: string;
  cols: number;
  rows: number;
  inputBuffer: string[];
  /**
   * 供 killProcessTree 使用的句柄视图（懒建、随会话长存）。
   * **不能每次现造**：整树退出边界记在 WeakSet 里、按对象身份认，现造的话防 pid 复用就失效。
   */
  killable?: KillableChild;
}

export interface PtySessionInfo {
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  command: string;
  args: string[];
  cwd: string;
  ownerSessionId?: string;
  toolCallId?: string;
  startTime: number;
  endTime?: number;
  duration: number;
  exitCode?: number;
  outputFile: string;
  cols: number;
  rows: number;
}

export interface PtySessionOutput {
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  output: string;
  exitCode?: number;
  duration: number;
}

type PtySessionLifecycleEventType = 'started' | 'completed' | 'failed';

export interface PtySessionLifecycleEvent {
  type: PtySessionLifecycleEventType;
  session: PtySessionInfo;
}

// ============================================================================
// Session Storage
// ============================================================================

const ptySessions: Map<string, PtySessionState> = new Map();
const ptySessionEvents = new EventEmitter();
ptySessionEvents.setMaxListeners(50);

// ============================================================================
// Directory Management
// ============================================================================

function getPtyDir(): string {
  const ptyDir = path.join(getUserConfigDir(), 'pty');
  if (!fs.existsSync(ptyDir)) {
    fs.mkdirSync(ptyDir, { recursive: true });
  }
  return ptyDir;
}

function getPtyOutputPath(sessionId: string): string {
  return path.join(getPtyDir(), `${sessionId}.log`);
}

function toPtySessionInfo(session: PtySessionState): PtySessionInfo {
  return {
    sessionId: session.sessionId,
    status: session.status,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    ownerSessionId: session.ownerSessionId,
    toolCallId: session.toolCallId,
    startTime: session.startTime,
    endTime: session.endTime,
    duration: (session.endTime || Date.now()) - session.startTime,
    exitCode: session.exitCode,
    outputFile: session.outputFile,
    cols: session.cols,
    rows: session.rows,
  };
}

function emitPtySessionLifecycleEvent(type: PtySessionLifecycleEventType, session: PtySessionState): void {
  ptySessionEvents.emit('lifecycle', {
    type,
    session: toPtySessionInfo(session),
  } satisfies PtySessionLifecycleEvent);
}

export function onPtySessionLifecycleEvent(
  listener: (event: PtySessionLifecycleEvent) => void,
): () => void {
  ptySessionEvents.on('lifecycle', listener);
  return () => ptySessionEvents.off('lifecycle', listener);
}

// ============================================================================
// PTY Session Lifecycle
// ============================================================================

/**
 * Create a new PTY session
 */
export function createPtySession(options: {
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  maxRuntime?: number;
  sessionId?: string;
  toolCallId?: string;
}): { success: boolean; sessionId?: string; error?: string; outputFile?: string } {
  // Check session limit
  if (ptySessions.size >= MAX_PTY_SESSIONS) {
    const cleaned = cleanupCompletedPtySessions();
    if (cleaned === 0 && ptySessions.size >= MAX_PTY_SESSIONS) {
      return {
        success: false,
        error: `Maximum number of PTY sessions (${MAX_PTY_SESSIONS}) reached. Use process_kill to terminate some sessions.`,
      };
    }
  }

  const sessionId = uuidv4();
  const outputFile = getPtyOutputPath(sessionId);

  const {
    command,
    args = [],
    cwd,
    cols = 80,
    rows = 24,
    env = {},
    maxRuntime = PTY_DEFAULT_TIMEOUT,
  } = options;

  try {
    // Determine shell based on platform（win32：pwsh 优先 → powershell.exe 5.1 地板）
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? resolveWindowsShell() : process.env.SHELL || '/bin/bash';
    const fullCommand = `${command} ${args.join(' ')}`.trim();
    // PowerShell 无 bash 的 -c；用 -Command + UTF-8 编码注入（5.1 中文系统默认 GBK）
    const shellArgs = isWindows
      ? ['-NoLogo', '-NoProfile', '-Command', `${WINDOWS_SHELL_ENCODING_PRELUDE}; ${fullCommand}`]
      : ['-c', fullCommand];

    // Create PTY process（win32 显式走 ConPTY，winpty 仅作 node-pty 内部兜底）
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        ...env,
        TERM: 'xterm-256color',
      } as Record<string, string>,
      ...(isWindows ? { useConpty: true } : {}),
    });

    // Create output file stream
    const outputStream = fs.createWriteStream(outputFile, { flags: 'w' });

    const sessionState: PtySessionState = {
      sessionId,
      pty: ptyProcess,
      output: [],
      outputFile,
      outputStream,
      status: 'running',
      startTime: Date.now(),
      maxRuntime: Math.min(maxRuntime, PTY_DEFAULT_TIMEOUT),
      outputSize: 0,
      command,
      args,
      lastReadPosition: 0,
      cwd,
      ownerSessionId: options.sessionId,
      toolCallId: options.toolCallId,
      cols,
      rows,
      inputBuffer: [],
    };

    // Set timeout for max runtime
    const timeout = setTimeout(() => {
      if (sessionState.status === 'running') {
        console.warn(`[PTY] Session ${sessionId} exceeded max runtime, terminating...`);
        void terminatePtyProcess(sessionState).catch((err: unknown) => {
          console.error(`[PTY] Failed to kill session ${sessionId}:`, err);
        });
      }
    }, sessionState.maxRuntime);

    sessionState.timeout = timeout;

    // Handle PTY data
    ptyProcess.onData((data) => {
      sessionState.outputSize += data.length;

      // Write to file
      sessionState.outputStream?.write(data);

      // Store in memory (with limit)
      if (sessionState.outputSize < MAX_PTY_OUTPUT) {
        sessionState.output.push(data);
      } else if (!sessionState.output[sessionState.output.length - 1]?.includes('[Output limit reached]')) {
        sessionState.output.push('[Output limit reached - further output written to file only]\n');
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      sessionState.status = exitCode === 0 ? 'completed' : 'failed';
      sessionState.exitCode = exitCode;
      sessionState.endTime = Date.now();

      if (sessionState.timeout) {
        clearTimeout(sessionState.timeout);
      }

      // Close output stream
      sessionState.outputStream?.end();
      emitPtySessionLifecycleEvent(sessionState.status === 'completed' ? 'completed' : 'failed', sessionState);
    });

    ptySessions.set(sessionId, sessionState);
    emitPtySessionLifecycleEvent('started', sessionState);

    return {
      success: true,
      sessionId,
      outputFile,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: `Failed to create PTY session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Write input to a PTY session
 */
export function writeToPtySession(sessionId: string, data: string): { success: boolean; error?: string } {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  if (session.status !== 'running') {
    return { success: false, error: `PTY session ${sessionId} is not running (status: ${session.status})` };
  }

  try {
    session.pty.write(data);
    session.inputBuffer.push(data);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: `Failed to write to PTY: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Submit input to a PTY session (write + newline)
 */
export function submitToPtySession(sessionId: string, input: string): { success: boolean; error?: string } {
  return writeToPtySession(sessionId, input + '\n');
}

// resize 能力住在有视口的那个子系统（terminalSessionManager.resizeTerminalSession ←
// TerminalPanel ← IPC 'terminal/resize'）。ptyExecutor 的会话是无视口的后台 shell，
// 建会话时定一次 cols/rows 就够，故此处不留 resize 导出。

/**
 * 把 `IPty` 适配成 killProcessTree 要的最小子进程视图。
 *
 * node-pty 只给 `pid` 和 `kill(signal?)`，没有 `exitCode`/`signalCode`——退出信息走 `onExit`
 * 回填到会话状态，这里用 getter 暴露成实时值。视图缓存在会话上，因为整树退出边界是按
 * 对象身份记的（WeakSet），每次现造等于没有边界。
 */
function killableView(session: PtySessionState): KillableChild {
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
 * 终止 PTY 会话进程，**并等到整组确认退出**。
 *
 * 两步走：
 * 1. `pty.kill()` —— node-pty 自身的拆台（POSIX 发 SIGHUP；win32 拆 ConPTY 并杀控制台进程列表）。
 *    win32 上只有这一步能释放 agent 句柄，taskkill 替代不了。
 * 2. `killProcessTree` —— SIGTERM → 宽限 → SIGKILL → 轮询探活到确认退出（与后台任务同一份状态机）。
 *
 * POSIX 上 PTY 进程**天生是进程组长**（node-pty 用 `POSIX_SPAWN_SETSID`/`forkpty` 建会话，
 * 实测 `pid == pgid`），所以组模式无条件成立，不用像普通子进程那样要求 `detached: true`。
 * `pid > 0` 是闸门：`UnixTerminal` 在 `pty.open()` 路径下把 `_pid` 置 -1，
 * 那样 `process.kill(-pid)` 会打到 init 头上。
 *
 * 已知降级：win32 没有进程组语义，「确认退出」只能确认到 shell 自身。
 */
async function terminatePtyProcess(session: PtySessionState): Promise<void> {
  try { session.pty.kill(); } catch { /* node-pty 内部已吞，这里兜底 */ }
  await killProcessTree(killableView(session), { posixGroupKill: session.pty.pid > 0 });
}

/**
 * Kill a PTY session（等到整组确认退出才返回——「已终止」是对调用方的承诺）
 */
export async function killPtySession(sessionId: string): Promise<{ success: boolean; error?: string; message?: string }> {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  try {
    await terminatePtyProcess(session);
    session.outputStream?.end();

    // Update status
    session.status = 'failed';
    session.endTime = Date.now();

    if (session.timeout) {
      clearTimeout(session.timeout);
    }

    return {
      success: true,
      message: `Successfully killed PTY session: ${sessionId} (${session.command})`,
    };
  } catch (error: unknown) {
    return { success: false, error: `Failed to kill PTY session: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Get PTY session output
 */
export async function getPtySessionOutput(
  sessionId: string,
  block: boolean = false,
  timeout: number = 30000
): Promise<PtySessionOutput | null> {
  const session = ptySessions.get(sessionId);
  if (!session) return null;

  // If blocking and still running, wait
  if (block && session.status === 'running') {
    const startTime = Date.now();

    while (session.status === 'running' && Date.now() - startTime < timeout) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const output = session.output.join('');
  const duration = (session.endTime || Date.now()) - session.startTime;

  return {
    sessionId,
    status: session.status,
    output,
    exitCode: session.exitCode,
    duration,
  };
}

/**
 * Poll PTY session for new output since last read
 */
export function pollPtySession(sessionId: string): {
  success: boolean;
  data?: string;
  status?: 'running' | 'completed' | 'failed';
  exitCode?: number;
  error?: string;
} {
  const session = ptySessions.get(sessionId);
  if (!session) {
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  const fullOutput = session.output.join('');
  const newData = fullOutput.substring(session.lastReadPosition);
  session.lastReadPosition = fullOutput.length;

  return {
    success: true,
    data: newData,
    status: session.status,
    exitCode: session.exitCode,
  };
}

/**
 * Get PTY session log from file
 */
export function getPtySessionLog(sessionId: string, tail?: number): {
  success: boolean;
  log?: string;
  error?: string;
} {
  const session = ptySessions.get(sessionId);
  if (!session) {
    // Try to read from file directly if session was cleaned up
    const logPath = getPtyOutputPath(sessionId);
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, 'utf-8');
        if (tail && tail > 0) {
          const lines = content.split('\n');
          return { success: true, log: lines.slice(-tail).join('\n') };
        }
        return { success: true, log: content };
      } catch (error: unknown) {
        return { success: false, error: `Failed to read log file: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { success: false, error: `No PTY session found with ID: ${sessionId}` };
  }

  try {
    const content = fs.readFileSync(session.outputFile, 'utf-8');
    if (tail && tail > 0) {
      const lines = content.split('\n');
      return { success: true, log: lines.slice(-tail).join('\n') };
    }
    return { success: true, log: content };
  } catch (error: unknown) {
    return { success: false, error: `Failed to read log file: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Get all PTY sessions info
 */
export function getAllPtySessions(): PtySessionInfo[] {
  const result: PtySessionInfo[] = [];

  for (const [, session] of ptySessions) {
    result.push(toPtySessionInfo(session));
  }

  return result;
}

/**
 * Get a specific PTY session
 */
export function getPtySession(sessionId: string): PtySessionState | undefined {
  return ptySessions.get(sessionId);
}

/**
 * Check if a session ID exists
 */
export function isPtySessionId(sessionId: string): boolean {
  return ptySessions.has(sessionId);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Cleanup completed PTY sessions (remove from memory, keep files)
 */
function cleanupCompletedPtySessions(): number {
  let cleaned = 0;

  for (const [sessionId, session] of ptySessions) {
    if (session.status !== 'running') {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      session.outputStream?.end();
      ptySessions.delete(sessionId);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Cleanup timed out PTY sessions
 */
async function cleanupTimedOutPtySessions(): Promise<void> {
  const now = Date.now();

  for (const [sessionId, session] of ptySessions) {
    if (session.status === 'running' && now - session.startTime > session.maxRuntime) {
      console.warn(`[PTY] Session ${sessionId} timed out, killing...`);
      await killPtySession(sessionId);
    }
  }
}

/**
 * 收掉全部在跑的 PTY 会话，逐个等确认退出。停机收尸（reapChildProcesses）用。
 *
 * @returns 确认收掉的会话数
 */
export async function reapPtySessions(): Promise<number> {
  const running = [...ptySessions.keys()].filter((id) => ptySessions.get(id)?.status === 'running');
  const results = await Promise.all(
    running.map(async (sessionId) => {
      try {
        return (await killPtySession(sessionId)).success;
      } catch (error) {
        console.warn(`[shutdown] failed to kill PTY session ${sessionId}:`, error);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

// Start periodic cleanup（捕获 handle + onShutdown 注册 + .unref() 三重保护）
const ptyCleanupTimer = setInterval(() => {
  void cleanupTimedOutPtySessions();
}, PTY_CLEANUP_INTERVAL);
ptyCleanupTimer.unref();

import('../../services/infra/gracefulShutdown')
  .then(({ onShutdown }) => {
    onShutdown('shell/ptyExecutor.cleanup', async () => {
      clearInterval(ptyCleanupTimer);
    });
  })
  .catch(() => { /* shutdown infra 不可用就靠 .unref() */ });

// ============================================================================
// Persistence —— 已删除（2026-08-14，N-DSH-STOP6）
// ============================================================================
//
// 这里原本有一套「退出时把在跑的会话写进 ~/.code-agent/pty-sessions.json，
// 启动时读回来」的持久化。删掉的理由：**它自诞生（a3a7cce47）起就只有写方、没有读方**，
// `loadPersistedPtySessions` / `clearPersistedPtySessions` 全仓零调用方（含 src-tauri Rust 侧），
// 而且即便接上也恢复不了任何东西——读回来的每一条都被强制改成 status:'failed'（PTY 句柄
// 不可能跨进程复活），能提供的只有一句「上次退出时有 N 个会话没了」；STOP1/STOP3 之后停机
// 路径会主动 reapPtySessions() 收干净，连这句都恒为空。
//
// 真正需要跨重启收尾的是 terminalSessionManager：它落盘的是 **pid**，启动时
// reapOrphanTerminals() 带两道核对去收割孤儿——那是有读方、有用途的持久化，别跟这个混淆。
//
// 依赖图与逐符号判据见 docs/design/2026-08-14-pty-executor-dead-export-map.md。
