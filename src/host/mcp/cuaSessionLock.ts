/**
 * 跨会话 computer-use 文件锁（cua-driver 链路）。
 *
 * cua-driver 上游（trycua/cua libs/cua-driver，已核实 v0.8.1）没有跨进程互斥：
 * 两个 agent 会话同时操作桌面会互相抢鼠标/键盘/焦点。本模块参照
 * argus src/computerUseLock.ts（源自 Claude Code）的 O_EXCL 文件锁实现，
 * 并默认使用同一个锁文件路径 ~/.claude/computer-use.lock —— 这样 Neo、
 * Claude Code、argus 三方的 computer use 天然互斥，不会互相打架。
 *
 * 与 argus 的差异：Neo 是单进程多会话（多个对话共享 Electron 主进程 pid），
 * 所以纯 pid 存活检测无法区分"同进程里另一个对话还在用"和"用完忘了放"。
 * 增加 lastUsedAt + TTL：同进程内闲置超过 TTL 的锁可被其他会话接管；
 * 外部存活进程的锁永不接管（不抢活进程的桌面），只回收死进程的锁。
 * 锁记录保留 argus 校验所需的 {sessionId, pid} 字段，双向兼容。
 */

import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';

const LOCK_FILENAME = 'computer-use.lock';

/** 同进程内会话锁的闲置接管阈值。活跃轨迹每次调用都会刷新 lastUsedAt。 */
export const CUA_LOCK_TTL_MS = 120_000;

interface CuaLockRecord {
  sessionId: string;
  pid: number;
  acquiredAt: number;
  lastUsedAt?: number;
}

type CuaLockReadResult =
  | { kind: 'record'; record: CuaLockRecord }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'error'; error: unknown };

export type CuaAcquireResult =
  | { kind: 'acquired' }
  | { kind: 'blocked'; by: string };

export type CuaInputLockLifecycleEvent = {
  scope: string;
  phase: 'acquire' | 'recover' | 'release';
  status: 'succeeded' | 'failed';
  outcome:
    | 'acquired'
    | 'reentrant'
    | 'blocked'
    | 'recovered'
    | 'released'
    | 'already_released'
    | 'not_owner'
    | 'error';
  occurredAt: number;
};

export type CuaInputLockLifecycleObserver = (
  event: CuaInputLockLifecycleEvent,
) => void;

const lifecycleObservers = new Set<CuaInputLockLifecycleObserver>();

function publishLifecycle(
  event: Omit<CuaInputLockLifecycleEvent, 'occurredAt'>,
  observer?: CuaInputLockLifecycleObserver,
): void {
  const completed = { ...event, occurredAt: Date.now() } satisfies CuaInputLockLifecycleEvent;
  // Lock safety must never depend on telemetry/event projection availability.
  try {
    observer?.(structuredClone(completed));
  } catch {
    // Ignore observer failures and preserve the lock outcome.
  }
  for (const listener of lifecycleObservers) {
    try {
      listener(structuredClone(completed));
    } catch {
      // Ignore observer failures and preserve the lock outcome.
    }
  }
}

export function subscribeCuaInputLockLifecycle(
  observer: CuaInputLockLifecycleObserver,
): () => void {
  lifecycleObservers.add(observer);
  return () => lifecycleObservers.delete(observer);
}

function getLockPath(): string {
  return process.env.CODE_AGENT_CU_LOCK_PATH || join(homedir(), '.claude', LOCK_FILENAME);
}

function isCuaLockRecord(value: unknown): value is CuaLockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string' && typeof v.pid === 'number';
}

async function inspectLock(): Promise<CuaLockReadResult> {
  try {
    const raw = await readFile(getLockPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isCuaLockRecord(parsed)
      ? { kind: 'record', record: parsed }
      : { kind: 'invalid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
    if (error instanceof SyntaxError) return { kind: 'invalid' };
    return { kind: 'error', error };
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM = 进程存在但无权限发信号（如其他用户的进程），仍算存活
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

async function tryCreateExclusive(record: CuaLockRecord): Promise<boolean> {
  try {
    await writeFile(getLockPath(), JSON.stringify(record), { flag: 'wx' });
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw e;
  }
}

function buildRecord(sessionId: string): CuaLockRecord {
  const now = Date.now();
  return { sessionId, pid: process.pid, acquiredAt: now, lastUsedAt: now };
}

/** 锁文件存在但内容损坏/被占用者放弃时，清掉重试一次。 */
async function recoverAndAcquire(sessionId: string): Promise<CuaAcquireResult> {
  try {
    await unlink(getLockPath()).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    });
    if (await tryCreateExclusive(buildRecord(sessionId))) {
      publishLifecycle({
        scope: sessionId,
        phase: 'recover',
        status: 'succeeded',
        outcome: 'recovered',
      });
      return { kind: 'acquired' };
    }
    publishLifecycle({
      scope: sessionId,
      phase: 'recover',
      status: 'failed',
      outcome: 'blocked',
    });
    const current = await inspectLock();
    if (current.kind === 'error') throw current.error;
    return {
      kind: 'blocked',
      by: current.kind === 'record' ? current.record.sessionId : 'unknown',
    };
  } catch (error) {
    publishLifecycle({
      scope: sessionId,
      phase: 'recover',
      status: 'failed',
      outcome: 'error',
    });
    throw error;
  }
}

export async function tryAcquireCuaLock(sessionId: string): Promise<CuaAcquireResult> {
  try {
    await mkdir(dirname(getLockPath()), { recursive: true });

    if (await tryCreateExclusive(buildRecord(sessionId))) {
      publishLifecycle({
        scope: sessionId,
        phase: 'acquire',
        status: 'succeeded',
        outcome: 'acquired',
      });
      return { kind: 'acquired' };
    }

    const inspected = await inspectLock();
    if (inspected.kind === 'error') throw inspected.error;

    // 文件存在但不是合法锁记录 → 按损坏处理
    if (inspected.kind !== 'record') {
      const recovered = await recoverAndAcquire(sessionId);
      publishLifecycle({
        scope: sessionId,
        phase: 'acquire',
        status: recovered.kind === 'acquired' ? 'succeeded' : 'failed',
        outcome: recovered.kind === 'acquired' ? 'recovered' : 'blocked',
      });
      return recovered;
    }
    const existing = inspected.record;

    // 同会话重入：刷新 lastUsedAt，保持活跃轨迹不被 TTL 接管
    if (existing.sessionId === sessionId) {
      await writeFile(getLockPath(), JSON.stringify({ ...existing, lastUsedAt: Date.now() }));
      publishLifecycle({
        scope: sessionId,
        phase: 'acquire',
        status: 'succeeded',
        outcome: 'reentrant',
      });
      return { kind: 'acquired' };
    }

    // 持有者进程已死 → 回收
    if (!isProcessRunning(existing.pid)) {
      const recovered = await recoverAndAcquire(sessionId);
      publishLifecycle({
        scope: sessionId,
        phase: 'acquire',
        status: recovered.kind === 'acquired' ? 'succeeded' : 'failed',
        outcome: recovered.kind === 'acquired' ? 'recovered' : 'blocked',
      });
      return recovered;
    }

    // 同进程内另一会话：闲置超过 TTL 才接管
    if (existing.pid === process.pid) {
      const lastUsed = existing.lastUsedAt ?? existing.acquiredAt;
      if (Date.now() - lastUsed > CUA_LOCK_TTL_MS) {
        const recovered = await recoverAndAcquire(sessionId);
        publishLifecycle({
          scope: sessionId,
          phase: 'acquire',
          status: recovered.kind === 'acquired' ? 'succeeded' : 'failed',
          outcome: recovered.kind === 'acquired' ? 'recovered' : 'blocked',
        });
        return recovered;
      }
    }

    publishLifecycle({
      scope: sessionId,
      phase: 'acquire',
      status: 'failed',
      outcome: 'blocked',
    });
    return { kind: 'blocked', by: existing.sessionId };
  } catch (error) {
    publishLifecycle({
      scope: sessionId,
      phase: 'acquire',
      status: 'failed',
      outcome: 'error',
    });
    throw error;
  }
}

/**
 * 不动鼠标键盘、不改桌面状态的工具，无需互斥。未列出的一律按操控类处理。
 * 清单对照 cua-driver 0.8.1 tools/list；未列出的一律按写操作处理。
 * start_session/end_session 只声明 run 身份/清理 agent cursor，不碰桌面：
 * end_session 尤其必须放行，否则被锁挡住的 run 无法善后自己的 cursor。
 */
export const CUA_READONLY_TOOLS = new Set([
  'screenshot',
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'get_accessibility_tree',
  'check_permissions',
  'get_screen_size',
  'get_cursor_position',
  'get_config',
  'get_agent_cursor_state',
  'get_recording_state',
  'health_report',
  'zoom',
  'check_for_update',
  'start_session',
  'end_session',
]);

/**
 * cua-driver 工具调用的锁闸门。
 * 返回 null 表示放行；返回字符串表示拒绝，内容是可直接喂给模型的错误提示。
 */
export async function gateCuaToolCall(
  toolName: string,
  sessionId: string,
): Promise<string | null> {
  if (CUA_READONLY_TOOLS.has(toolName)) return null;
  const result = await tryAcquireCuaLock(sessionId);
  if (result.kind === 'acquired') return null;
  return (
    `另一个会话（${result.by}）正在使用计算机，本次桌面操作已拒绝以避免鼠标键盘冲突。` +
    `请等待对方完成后重试；若确认对方已不在使用，可让用户关闭该会话或等待约 ${Math.round(
      CUA_LOCK_TTL_MS / 1000,
    )} 秒闲置后自动接管。只读观察类工具（screenshot/get_window_state）不受影响，可继续使用。`
  );
}

export async function releaseCuaLock(
  sessionId: string,
  observer?: CuaInputLockLifecycleObserver,
): Promise<boolean> {
  const inspected = await inspectLock();
  if (inspected.kind === 'missing') {
    publishLifecycle({
      scope: sessionId,
      phase: 'release',
      status: 'succeeded',
      outcome: 'already_released',
    }, observer);
    return false;
  }
  if (inspected.kind === 'invalid' || inspected.kind === 'error') {
    publishLifecycle({
      scope: sessionId,
      phase: 'release',
      status: 'failed',
      outcome: 'error',
    }, observer);
    return false;
  }
  const existing = inspected.record;
  if (existing.sessionId !== sessionId) {
    publishLifecycle({
      scope: sessionId,
      phase: 'release',
      status: 'failed',
      outcome: 'not_owner',
    }, observer);
    return false;
  }
  try {
    await unlink(getLockPath());
    publishLifecycle({
      scope: sessionId,
      phase: 'release',
      status: 'succeeded',
      outcome: 'released',
    }, observer);
    return true;
  } catch (error) {
    const alreadyReleased = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    publishLifecycle({
      scope: sessionId,
      phase: 'release',
      status: alreadyReleased ? 'succeeded' : 'failed',
      outcome: alreadyReleased ? 'already_released' : 'error',
    }, observer);
    return false;
  }
}
