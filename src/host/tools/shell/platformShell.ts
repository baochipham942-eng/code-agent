// ============================================================================
// Platform Shell - Windows shell 调用与跨平台进程树终止
// POSIX 路径保持各调用点原有行为（bash -c / shell:true），本模块只收敛 win32 差异
// ============================================================================

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';

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

/**
 * 终止进程及其全部子孙。
 * - win32：负 PID 与 POSIX 信号语义都不可用，走 taskkill /T（SIGKILL → /F 强杀），
 *   taskkill 不可用时回退 child.kill（只杀直接子进程，聊胜于无）。
 * - POSIX + posixGroupKill：整组 kill(-pid)（要求 spawn 时 detached:true 成组），
 *   组不存在时回退直接子进程。
 * - POSIX 默认：直接 child.kill（保持 detached:false 调用点的原有语义）。
 */
export function killProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals,
  options: { posixGroupKill?: boolean; platform?: NodeJS.Platform } = {},
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const platform = options.platform ?? process.platform;

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

  if (options.posixGroupKill) {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* 组不存在（进程已退/非组长），回退单进程 */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}
