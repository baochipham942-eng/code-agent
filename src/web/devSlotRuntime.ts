// ============================================================================
// dev 槽位运行时探测 — webEnvInit 专用
// ============================================================================
// 把「当前检出是不是 git 工作树」「某槽是否空闲」的真实探测集中在这里，
// channelDataDir.resolveChannelDataDir 保持纯函数（探测结果以参数注入）。
//
// 槽位占用的硬判据与 scripts/lib/tauri-slot-process-guard.sh 的
// refuse_if_tauri_slot_in_use 同口径（门只守装包的时代漏洞，这里补上启动侧）：
//   1. 本槽端口（8180+N）存在 LISTEN 进程（浏览器 ESTABLISHED 连接不算）；
//   2. 本槽数据目录里的 sqlite 库文件（code-agent.db 及 -wal/-shm）被活进程持有。
// 只看目录存在与否会误判——~/.code-agent-dev2/-dev3 常驻存在但不一定在跑。
// 槽位命名/端口一律走 src/shared/devSlot.ts 单一真源，不在此重算（两处各算一遍
// 就会在换槽时错开）。
// ============================================================================

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DevSlotProbeContext } from './channelDataDir';
import { devSlotDataDirName, devSlotWebPort } from '../shared/devSlot';

/** 可注入的同步执行器（单测用假实现替换 lsof/git/ps）。模块内型别，不导出。 */
type ProbeExec = (file: string, args: string[]) => string;

const defaultExec: ProbeExec = (file, args) => execFileSync(file, args, { encoding: 'utf-8' });

/** 活实例必然持有打开句柄的数据目录文件（sqlite 主库 + wal/shm）。 */
const SLOT_DB_FILES = ['code-agent.db', 'code-agent.db-wal', 'code-agent.db-shm'] as const;

export interface DevSlotRuntimeOptions {
  exec?: ProbeExec;
  /** git 探测锚点目录；缺省取本模块所在目录（检出/worktree 内，或 app 包内）。 */
  anchorDir?: string;
  homedir?: string;
}

function listPids(output: string): number[] {
  return [...new Set(output.split(/\s+/).filter(pid => /^\d+$/.test(pid)).map(Number))];
}

/** 本槽端口有没有 LISTEN 进程。lsof 无匹配时 exit 1 → 视为无。 */
function portListenerPids(port: number, exec: ProbeExec): number[] {
  try {
    return listPids(exec('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']));
  } catch {
    return [];
  }
}

/** 本槽数据目录有没有活进程持有库文件。文件不存在 → 无人持有（目录存在 ≠ 占用）。 */
function dataDirHolderPids(dataDir: string, exec: ProbeExec): number[] {
  const targets = SLOT_DB_FILES.map(name => path.join(dataDir, name)).filter(file => fs.existsSync(file));
  if (targets.length === 0) return [];
  try {
    return listPids(exec('lsof', ['-t', '-nP', ...targets]));
  } catch {
    return [];
  }
}

function commandOf(pid: number, exec: ProbeExec): string {
  try {
    return exec('ps', ['-p', String(pid), '-o', 'command=']).trim() || '<command unavailable>';
  } catch {
    return '<command unavailable>';
  }
}

/**
 * git linked worktree 判定：worktree 的 git-dir 在 <主仓>/.git/worktrees/<名> 下，
 * 与 git-common-dir（主仓 .git）不同；主检出两者相同。非 git 环境（打包态）判 false
 * → 等同主检出语义（且打包态总有 Rust 显式注入的数据目录，走不到这里）。
 */
function detectGitWorktree(anchorDir: string, exec: ProbeExec): boolean {
  try {
    const gitDir = exec('git', ['-C', anchorDir, 'rev-parse', '--absolute-git-dir']).trim();
    const commonRaw = exec('git', ['-C', anchorDir, 'rev-parse', '--git-common-dir']).trim();
    const commonDir = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(anchorDir, commonRaw);
    const realOrSelf = (dir: string): string => {
      try {
        return fs.realpathSync.native(dir);
      } catch {
        return dir; // 探测路径缺失时退回字面值比较，不把"判不了"当工作树
      }
    };
    return realOrSelf(gitDir) !== realOrSelf(commonDir);
  } catch {
    return false;
  }
}

/** 探测当前进程的槽位上下文；git 判定惰性且记忆化，lsof 只在真正要判定槽位时才跑。 */
export function detectDevSlotRuntime(options: DevSlotRuntimeOptions = {}): DevSlotProbeContext {
  const exec = options.exec ?? defaultExec;
  const anchorDir = options.anchorDir ?? __dirname;
  const homedir = options.homedir ?? os.homedir();

  let worktreeMemo: boolean | undefined;
  return {
    isGitWorktree: () => (worktreeMemo ??= detectGitWorktree(anchorDir, exec)),
    isSlotFree: slot => {
      const port = devSlotWebPort(slot);
      if (portListenerPids(port, exec).length > 0) return false;
      return dataDirHolderPids(path.join(homedir, devSlotDataDirName(slot)), exec).length === 0;
    },
    describeSlotOccupancy: slot => {
      const port = devSlotWebPort(slot);
      const dataDir = path.join(homedir, devSlotDataDirName(slot));
      const lines = [`  槽 ${slot}（~/${devSlotDataDirName(slot)}，端口 ${port}）：`];
      for (const pid of portListenerPids(port, exec)) {
        lines.push(`    pid=${pid} criterion=tcp-listen:${port} command=${commandOf(pid, exec)}`);
      }
      for (const pid of dataDirHolderPids(dataDir, exec)) {
        lines.push(`    pid=${pid} criterion=data-dir-open command=${commandOf(pid, exec)}`);
      }
      return lines.join('\n');
    },
  };
}
