// ============================================================================
// Tool Result Spill — 大工具结果落盘 (GAP-009)
// ============================================================================
// 所有截断点（bash 30K chars / MCP 50K chars / L1 budget 2000 tokens）在截断前
// 调用 spillToolResult，把完整输出写入 session 临时目录，截断文本尾部附加路径提示，
// 模型可用 Read/Grep 零成本回查完整输出，不必重跑命令。
//
// 设计原则：
// - best-effort：落盘失败绝不影响工具结果本身（返回 null，调用方跳过提示）
// - 防重复：已带落盘提示的内容跳过（L1 budget 不会对 bash 已落盘的结果二次落盘）
// - 不引入 logger 依赖，保持 import 图最小（toolResultBudget 等纯函数层也要用）
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import { TOOL_RESULT_SPILL } from '../../shared/constants';

/** 落盘提示的标识前缀（同时用于防止重复落盘） */
export const SPILL_NOTICE_MARKER = '[Full output saved to:';

export interface SpillOptions {
  /** 完整输出内容 */
  content: string;
  /** 工具名（用于文件名） */
  toolName: string;
  /** 会话 ID（用于目录隔离），缺省落到 shared 目录 */
  sessionId?: string;
  /** 工具调用 ID（用于文件名唯一性），缺省用时间戳 */
  toolCallId?: string;
}

/** 路径片段消毒：防止 sessionId / toolName 里的特殊字符构造出意外路径（含 .. 遍历 / 隐藏目录） */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^\.+/, '_');
}

/** 获取 session 的工具结果落盘目录：~/.code-agent/tmp/<session>/tool-results/ */
export function getToolResultSpillDir(sessionId?: string): string {
  return path.join(
    getUserConfigDir(),
    TOOL_RESULT_SPILL.TMP_DIR,
    sanitizeSegment(sessionId || TOOL_RESULT_SPILL.SHARED_SESSION),
    TOOL_RESULT_SPILL.SUBDIR,
  );
}

/**
 * 把超长工具输出写入磁盘，返回文件路径；失败或跳过时返回 null。
 *
 * 跳过条件：
 * - 内容为空
 * - 内容已包含落盘提示（防止逐层重复落盘）
 * - 内容超过 MAX_SPILL_BYTES（防止写爆磁盘）
 */
export function spillToolResult(options: SpillOptions): string | null {
  const { content, toolName, sessionId, toolCallId } = options;
  if (!content) return null;
  if (content.includes(SPILL_NOTICE_MARKER)) return null;
  if (Buffer.byteLength(content, 'utf-8') > TOOL_RESULT_SPILL.MAX_SPILL_BYTES) return null;

  try {
    const dir = getToolResultSpillDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${sanitizeSegment(toolName)}-${sanitizeSegment(toolCallId || String(Date.now()))}.txt`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch {
    // 落盘是增强而非保障，任何 fs 错误（磁盘满/权限/只读环境）都静默降级为纯截断
    return null;
  }
}

/** 构造落盘路径提示文本（附加在截断输出尾部，模型可见） */
export function buildSpillNotice(filePath: string): string {
  return `\n${SPILL_NOTICE_MARKER} ${filePath} — use Read/Grep on this file to inspect the full output.]`;
}
