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

export type CuaAcquireResult =
  | { kind: 'acquired' }
  | { kind: 'blocked'; by: string };

function getLockPath(): string {
  return process.env.CODE_AGENT_CU_LOCK_PATH || join(homedir(), '.claude', LOCK_FILENAME);
}

function isCuaLockRecord(value: unknown): value is CuaLockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string' && typeof v.pid === 'number';
}

async function readLock(): Promise<CuaLockRecord | undefined> {
  try {
    const raw = await readFile(getLockPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isCuaLockRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
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
  await unlink(getLockPath()).catch(() => {});
  if (await tryCreateExclusive(buildRecord(sessionId))) {
    return { kind: 'acquired' };
  }
  return { kind: 'blocked', by: (await readLock())?.sessionId ?? 'unknown' };
}

export async function tryAcquireCuaLock(sessionId: string): Promise<CuaAcquireResult> {
  await mkdir(dirname(getLockPath()), { recursive: true });

  if (await tryCreateExclusive(buildRecord(sessionId))) {
    return { kind: 'acquired' };
  }

  const existing = await readLock();

  // 文件存在但不是合法锁记录 → 按损坏处理
  if (!existing) return recoverAndAcquire(sessionId);

  // 同会话重入：刷新 lastUsedAt，保持活跃轨迹不被 TTL 接管
  if (existing.sessionId === sessionId) {
    await writeFile(getLockPath(), JSON.stringify({ ...existing, lastUsedAt: Date.now() }));
    return { kind: 'acquired' };
  }

  // 持有者进程已死 → 回收
  if (!isProcessRunning(existing.pid)) return recoverAndAcquire(sessionId);

  // 同进程内另一会话：闲置超过 TTL 才接管
  if (existing.pid === process.pid) {
    const lastUsed = existing.lastUsedAt ?? existing.acquiredAt;
    if (Date.now() - lastUsed > CUA_LOCK_TTL_MS) return recoverAndAcquire(sessionId);
  }

  return { kind: 'blocked', by: existing.sessionId };
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

export async function releaseCuaLock(sessionId: string): Promise<boolean> {
  const existing = await readLock();
  if (existing?.sessionId !== sessionId) return false;
  try {
    await unlink(getLockPath());
    return true;
  } catch {
    return false;
  }
}
