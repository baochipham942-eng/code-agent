// ============================================================================
// Platform Shell - Windows shell 调用与跨平台进程树终止
// POSIX 路径保持各调用点原有行为（bash -c / shell:true），本模块只收敛 win32 差异
// ============================================================================

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { SHELL_KILL } from '../../../shared/constants/tools';

/**
 * UTF-8 编码注入（windows-support.md 决策：PowerShell 5.1 为兼容地板）。
 * 中文 Windows 上 PS 5.1 默认用 OEM 代码页（GBK）写 stdout/管道，中文输出乱码；
 * pwsh 7 默认 UTF-8，注入幂等无副作用。
 */
export const WINDOWS_SHELL_ENCODING_PRELUDE =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8';

let cachedWindowsShell: string | null = null;

/**
 * Windows 主 shell 解析：pwsh 7 优先（编码/性能更好），powershell.exe (5.1)
 * 是 Win10+ 保底存在（windows-support.md §3.2 决策）。结果进程级缓存。
 */
export function resolveWindowsShell(): string {
  if (cachedWindowsShell) return cachedWindowsShell;
  try {
    const probe = spawnSync('where.exe', ['pwsh.exe'], { stdio: 'ignore', windowsHide: true });
    cachedWindowsShell = probe.status === 0 ? 'pwsh.exe' : 'powershell.exe';
  } catch {
    cachedWindowsShell = 'powershell.exe';
  }
  return cachedWindowsShell;
}

/** Windows 上把命令字符串交给 PowerShell 执行（含 UTF-8 编码注入）。 */
export function spawnWindowsShell(
  command: string,
  options: Pick<SpawnOptions, 'cwd' | 'env'>,
): ChildProcess {
  const wrapped = `${WINDOWS_SHELL_ENCODING_PRELUDE}; ${command}`;
  return spawn(resolveWindowsShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** killProcessTree 需要的最小子进程视图（真实 ChildProcess 天然满足）。 */
export type KillableChild = Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'>;

export interface KillProcessTreeOptions {
  /** POSIX：spawn 时 detached:true 让子进程自成进程组，可按组收树 */
  posixGroupKill?: boolean;
  platform?: NodeJS.Platform;
  /** SIGTERM 后的宽限期，超过升级 SIGKILL */
  graceMs?: number;
  /** SIGKILL 后仍未确认整树退出的放弃上限 */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * 永久退出边界：一旦观测到某个子进程句柄的整树退出，就再也不对它的 pid 发信号。
 * POSIX 的 pid 会被复用，迟到的升级信号打到复用者头上是真事故。
 */
const treeExitObserved = new WeakSet<object>();

/**
 * 整树是否还活着。
 * - 直接子进程尚未被回收 ⇒ 树必然活着（也顺带避开「组长已成僵尸但还没被 reap」
 *   被误判成整组存活）。
 * - 组模式下组长已退，则探整个进程组：ESRCH 判死，EPERM 判活（存在但无权限）。
 * - 非组模式（含 win32）只能以直接子进程的退出为边界——**这是降级**，
 *   win32 拿不到进程组语义，taskkill /T 之后无法证明子孙都没了。
 */
function treeAlive(child: KillableChild, pid: number, groupMode: boolean): boolean {
  const directChildExited = child.exitCode !== null || child.signalCode !== null;
  if (!directChildExited) return true;
  if (!groupMode) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sendSignal(
  child: KillableChild,
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  groupMode: boolean,
): void {
  if (platform === 'win32') {
    const args = ['/pid', String(pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {
        try { child.kill(signal); } catch { /* already exited */ }
      });
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
    return;
  }

  if (groupMode) {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* 组不存在（进程已退/非组长），回退单进程 */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

/**
 * 终止进程及其全部子孙，**并等到整树确认退出才 resolve**。
 *
 * 三个子系统（后台任务 / Bash 工具 / 脚本沙箱）此前各写了一遍
 * 「SIGTERM → 等一会 → SIGKILL」，且没有一个验证树真的死了；这里收敛成一份：
 * SIGTERM → graceMs → SIGKILL → 轮询探活 → 确认退出。
 *
 * 轮询定时器**保持 ref'd**（绝不 unref）：父进程在升级信号发出前先退，会留下一个
 * trap 住 SIGTERM 的幸存者变成孤儿——本仓 2026-07-30 的孤儿 Playwright/Chrome
 * 事故就是这个形状（见 .claude/rules/testing.md）。
 *
 * 真正杀不掉的进程不会无限挂住调用方：confirmTimeoutMs 到点记 warn 后返回。
 */
export async function killProcessTree(
  child: KillableChild,
  options: KillProcessTreeOptions = {},
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (treeExitObserved.has(child)) return;

  const platform = options.platform ?? process.platform;
  const groupMode = platform !== 'win32' && options.posixGroupKill === true;
  const graceMs = options.graceMs ?? SHELL_KILL.GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SHELL_KILL.POLL_INTERVAL_MS;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? SHELL_KILL.CONFIRM_TIMEOUT_MS;

  // 本来就死了：立刻返回，不空等宽限期。
  if (!treeAlive(child, pid, groupMode)) {
    treeExitObserved.add(child);
    return;
  }

  sendSignal(child, pid, 'SIGTERM', platform, groupMode);

  const startedAt = Date.now();
  let escalated = false;
  for (;;) {
    await new Promise<void>((resolve) => { setTimeout(resolve, pollIntervalMs); });

    if (!treeAlive(child, pid, groupMode)) {
      treeExitObserved.add(child);
      return;
    }

    const elapsed = Date.now() - startedAt;
    if (!escalated && elapsed >= graceMs) {
      escalated = true;
      sendSignal(child, pid, 'SIGKILL', platform, groupMode);
      continue;
    }
    if (elapsed >= confirmTimeoutMs) {
      console.warn(
        `[platformShell] pid ${pid} 的进程树在 ${confirmTimeoutMs}ms 内未确认退出，放弃等待`,
      );
      return;
    }
  }
}
