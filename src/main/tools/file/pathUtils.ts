// ============================================================================
// Path Utilities - 路径处理工具函数
// ============================================================================

import path from 'path';
import os from 'os';

/**
 * 展开波浪号路径 (~/xxx -> /Users/xxx/xxx)
 * Node.js 原生不支持 ~ 路径展开，需要手动处理
 */
export function expandTilde(filePath: string): string {
  if (!filePath) return filePath;

  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (filePath === '~') {
    return os.homedir();
  }

  return filePath;
}

/**
 * 解析路径为绝对路径
 * 1. 展开波浪号
 * 2. 将相对路径转换为绝对路径
 *
 * @param inputPath 输入路径
 * @param workingDirectory 当前工作目录（用于解析相对路径）
 */
export function resolvePath(inputPath: string, workingDirectory: string): string {
  // 先展开波浪号
  let resolvedPath = expandTilde(inputPath);

  // 如果不是绝对路径，则相对于工作目录解析
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(workingDirectory, resolvedPath);
  }

  return confineEvalPath(resolvedPath, workingDirectory);
}

/**
 * Eval 沙箱硬隔离：设了 CODE_AGENT_EVAL_REAL_ROOT 时，把落在"真仓根"下的绝对路径
 * 前缀重映射到沙箱 workingDirectory（结构保留）。其它路径原样返回。
 *
 * Why: eval 全自动批准 permission，agent 的 deny-writes-outside-cwd 防线失效；
 * mimo 可能直接用真仓绝对路径（如 /Users/.../code-agent/x.md）写文件，绕过"改
 * workingDirectory"的沙箱隔离污染主仓。前缀重映射让真仓绝对路径落回沙箱——写不
 * 污染主仓，读真仓路径仍命中沙箱里的 git archive 快照副本。仅 eval 设此 env，
 * 生产不开（生产靠 permission 层的 deny-outside-cwd）。
 */
export function confineEvalPath(resolvedAbsPath: string, workingDirectory: string): string {
  const realRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
  if (!realRoot || !workingDirectory) return resolvedAbsPath;
  const root = path.resolve(realRoot);
  const sandbox = path.resolve(workingDirectory);
  if (root === sandbox) return resolvedAbsPath; // 没启用沙箱（原地跑）
  const normalized = path.resolve(resolvedAbsPath);
  if (normalized === root) return sandbox;
  const rel = path.relative(root, normalized);
  // 不在真仓根下（含已在沙箱里的路径）→ 不动
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return resolvedAbsPath;
  return path.join(sandbox, rel);
}
