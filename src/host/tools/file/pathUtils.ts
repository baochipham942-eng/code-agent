// ============================================================================
// Path Utilities - 路径处理工具函数
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs';
import { resolveCanonicalRunPath } from '../../runtime/runContext';
import { CHAT_UPLOAD_DIR_NAME } from '../../../shared/constants/chatUploads';

/**
 * 把「可能不存在」的路径规范化：存在的前缀走 realpath（解析 /var → /private/var
 * 这类软链别名），不存在的尾部原样拼回——文件被清理后 realpathSync 会抛，
 * 不能拿它整条解析。
 */
function canonicalizePossiblyMissing(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target; // 到达文件系统根，无法再向上
    return path.join(canonicalizePossiblyMissing(parent), path.basename(target));
  }
}

/**
 * 是否落在聊天上传临时目录（web/Tauri 的 /api/upload/temp 落盘处，
 * webServer 启动/关停时整体清空）。Read 工具用它在上传副本 ENOENT 时
 * 给「上传已过期，请重新上传」的人话提示，而不是一句干巴巴的 not found。
 *
 * macOS os.tmpdir() 返回 /var/…（软链别名），而 document-evidence 锚、上传
 * 回执常以 realpath 形态（/private/var/…）回到 Read 工具——纯词法前缀比对会
 * 漏（realrun20：模型重读上传 csv 只拿到 not found，转告用户「临时文件已被系统
 * 清理」）。词法不中时两侧都按「存在前缀 realpath、缺失尾部保留」规范化再比，
 * 文件与上传根目录都不在了也能对上。
 */
export function isChatUploadPath(filePath: string): boolean {
  const uploadRoot = path.join(os.tmpdir(), CHAT_UPLOAD_DIR_NAME);
  if (filePath.startsWith(`${uploadRoot}${path.sep}`)) return true;
  const canonicalRoot = canonicalizePossiblyMissing(uploadRoot);
  const canonicalTarget = canonicalizePossiblyMissing(filePath);
  return canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`);
}

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
  let root = path.resolve(realRoot);
  let sandbox = path.resolve(workingDirectory);
  let normalized = path.resolve(resolvedAbsPath);
  try {
    root = resolveCanonicalRunPath(root);
    sandbox = resolveCanonicalRunPath(sandbox);
    normalized = resolveCanonicalRunPath(normalized);
  } catch {
    // Fail open to the previous lexical behavior; write tools must remain non-throwing here.
  }
  if (root === sandbox) return resolvedAbsPath; // 没启用沙箱（原地跑）
  if (normalized === root) return sandbox;
  const rel = path.relative(root, normalized);
  // 不在真仓根下（含已在沙箱里的路径）→ 不动
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return resolvedAbsPath;
  return path.join(sandbox, rel);
}
