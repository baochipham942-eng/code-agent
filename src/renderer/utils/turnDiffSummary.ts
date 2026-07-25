// ============================================================================
// turnDiffSummary - 从 turn 聚合 Edit/Write 变更（供 TurnDiffSummary 卡片消费）
//
// 抽出为纯函数便于单测。关键修复：Write 的 content 在事件流里会被
// sanitizeLargeTextToolArguments 压成片段（前160…后80），UI 直接对片段跑
// Diff.diffLines 会把 100+ 行的文件算成 +11。后端在截断前保留了权威行数
// args.content_lines，这里优先采用它。
// ============================================================================

import type { TraceNode, TraceTurn } from '@shared/contract/trace';
import { measureStreamingPerformanceTiming } from './streamingPerformanceMetrics';
import { diffLinesWithFastPath } from './fastDiff';

export const FILE_WRITE_TOOLS = ['Edit', 'Write', 'edit_file', 'write_file'];

export interface FileChange {
  filePath: string;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  isNewFile: boolean;
  editCount: number;
}

function countNonEmptyLines(value: string): number {
  return value.split('\n').filter((line) => line !== '').length;
}

type ToolCallLike = NonNullable<TraceNode['toolCall']>;

// 解析这次写入落在哪个文件上。对老会话 args 可能缺失，fallback 从 result 字符串解析。
function resolveFileChangePath(tc: ToolCallLike): string | null {
  const args = tc.args || {};
  let filePath = (args.file_path ?? args.path) as string | undefined;

  // Fallback: 从 result 字符串 "Created file: X" / "Updated file: X" 抽取路径
  if (!filePath && typeof tc.result === 'string') {
    const m = tc.result.match(/(?:Created|Updated) file:\s*(.+?)(?:\s+\(|\s*\n|$)/);
    if (m) filePath = m[1].trim();
  }
  if (!filePath && typeof tc.outputPath === 'string') {
    filePath = tc.outputPath;
  }
  return filePath || null;
}

/**
 * 这个节点的文件改动是否已由本轮的文件变更卡（TurnDiffSummary）完整承担。
 * 是 → 节点流里不再单独渲染它：否则「改了哪个文件」会在一屏里被讲三遍
 * （工具步骤行 + 行尾文件名徽标 + 卡内路径行），而卡片是三者里唯一带
 * 相对路径、增删行数、diff 与撤销的那个。
 * 失败的写入、卡片解析不出路径的写入、以及 MultiEdit/NotebookEdit（卡片不聚合）
 * 一律返回 false 继续显示——不能让一次真的失败静默消失。
 * ponytail: 与 buildTurnFileChanges 共用路径解析，但不重复它的"空编辑跳过"判定
 * （old===new 的编辑什么也没发生，卡片和节点流一起不显示是对的）。
 */
export function isFileChangeCardOwnedNode(node: TraceNode): boolean {
  if (node.type !== 'tool_call' || !node.toolCall) return false;
  const tc = node.toolCall;
  if (!FILE_WRITE_TOOLS.includes(tc.name)) return false;
  if (tc.success === false) return false;
  return resolveFileChangePath(tc) !== null;
}

// 聚合 turn.nodes 里成功的 Edit/Write，按 filePath 合并。
export function buildTurnFileChanges(turn: TraceTurn): FileChange[] {
  return measureStreamingPerformanceTiming('stream.diff.summary_ms', () => {
  const byPath = new Map<string, FileChange>();

  for (const node of turn.nodes) {
    if (node.type !== 'tool_call' || !node.toolCall) continue;
    const tc = node.toolCall;
    if (!FILE_WRITE_TOOLS.includes(tc.name)) continue;
    if (tc.success === false) continue;

    const args = tc.args || {};
    const filePath = resolveFileChangePath(tc);
    if (!filePath) continue;

    let oldText = '';
    let newText: string;
    let isNewFile = false;
    const isEdit = tc.name === 'Edit' || tc.name === 'edit_file';

    if (isEdit) {
      oldText = (args.old_string as string) ?? '';
      newText = (args.new_string as string) ?? '';
    } else {
      // Write / write_file：默认视作新建；若 result 显示 "Updated" 则改为修改
      newText = (args.content as string) ?? '';
      isNewFile = true;
      if (typeof tc.result === 'string' && /^Updated file/m.test(tc.result)) {
        isNewFile = false;
      }
    }

    // 空编辑跳过（仅当两者都非空且相等时；两者都空可能是 args 缺失的老会话，仍保留）
    if (oldText && newText && oldText === newText) continue;

    let added = 0;
    let removed = 0;

    // 权威行数：Write 的 content 被事件流截断时，args.content 是片段，但
    // args.content_lines 是后端在截断前留下的真实非空行数 —— 优先用它，避免
    // 对片段 diff 出错误的 +N。
    const contentLines =
      !isEdit && typeof args.content_lines === 'number' ? args.content_lines : undefined;

    if (contentLines !== undefined) {
      added = contentLines;
      removed = 0;
    } else if (oldText || newText) {
      const diffChanges = diffLinesWithFastPath(oldText, newText);
      for (const c of diffChanges) {
        const lines = countNonEmptyLines(c.value);
        if (c.added) added += lines;
        else if (c.removed) removed += lines;
      }
    }

    const existing = byPath.get(filePath);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
      existing.newText = newText;
      existing.editCount += 1;
    } else {
      byPath.set(filePath, {
        filePath,
        oldText,
        newText,
        added,
        removed,
        isNewFile,
        editCount: 1,
      });
    }
  }

  return Array.from(byPath.values());
  });
}
