// ============================================================================
// workspaceSnapshot — 验证工作区卫生（长任务收口）
//
// cowork 用户的工作区是他的"桌面"：QA/验证命令在工作区就地执行，产生的
// 临时产物此前无人核对。这里提供有界快照 + diff：验证跑前后各拍一次，
// diff 非空 → 证据标 workspaceSideEffects（不阻断验证，只如实入证据）。
// fail-safe：任何 IO 失败按空快照处理；超出条目上限标 truncated，调用方
// 应跳过 diff 防误报。纯同步实现（验证本身是命令级操作，快照成本相对可忽略）。
// ============================================================================

import { lstatSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** 跳过的重目录/生成目录：变更噪声大且不属于"用户可感知的工作区污染" */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out',
  '.next', '.turbo', '.cache', 'target', '__pycache__', '.venv', 'venv',
]);

const DEFAULT_MAX_ENTRIES = 2_000;
const MAX_DEPTH = 6;

export interface WorkspaceSnapshot {
  /** 相对路径 → 指纹（size + mtimeMs） */
  entries: Map<string, string>;
  /** 超出 maxEntries 提前停止：快照不完整，调用方应跳过 diff */
  truncated: boolean;
}

export interface CaptureOptions {
  maxEntries?: number;
}

export function captureWorkspaceSnapshot(
  cwd: string,
  options: CaptureOptions = {},
): WorkspaceSnapshot {
  // 家目录护栏（同 agentsDiscovery 的 TCC 教训）：工作目录=home 时绝不递归
  // 下钻——扫 ~/Desktop、~/Documents、~/Downloads 会逐个触发 macOS TCC 授权
  // 弹窗。标 truncated 让调用方跳过 diff，宁可不查也不弹窗。
  if (resolve(cwd) === homedir()) {
    return { entries: new Map(), truncated: true };
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, string>();
  let truncated = false;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // fail-safe：目录不可读按空处理
    }
    for (const name of names) {
      if (truncated) return;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        // lstat 不跟随 symlink：目录软链会把递归带出 cwd（外部变更误记为
        // 工作区副作用，且可能扫进 TCC 保护目录），symlink 一律跳过。
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, relPath, depth + 1);
      } else if (st.isFile()) {
        if (entries.size >= maxEntries) {
          truncated = true;
          return;
        }
        entries.set(relPath, `${st.size}:${Math.floor(st.mtimeMs)}`);
      }
    }
  };

  walk(cwd, '', 0);
  return { entries, truncated };
}

/**
 * 前后快照 diff。任一侧 truncated → 返回空（不完整快照 diff 必然误报）。
 * @returns 形如 'added: path' / 'modified: path' / 'removed: path' 的清单
 */
export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string[] {
  if (before.truncated || after.truncated) return [];
  const diff: string[] = [];
  for (const [path, fp] of after.entries) {
    const prev = before.entries.get(path);
    if (prev === undefined) diff.push(`added: ${path}`);
    else if (prev !== fp) diff.push(`modified: ${path}`);
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) diff.push(`removed: ${path}`);
  }
  return diff.sort();
}
