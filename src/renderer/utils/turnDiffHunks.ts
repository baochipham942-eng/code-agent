// ============================================================================
// turnDiffHunks - 把整文件 old/new 文本切成改动块（hunk），供改动卡下的块级反馈
//
// 与 buildTurnFileChanges 同一 diff 源（diff.diffLines）。行号是**新文件**坐标：
// 权威 diff 的 oldText/newText 是磁盘整文件文本（buildTurnFileChanges 的 caveat），
// 所以行号可以直接对着用户当下看到的文件讲。摘录带上 +/- 前缀，文件此后再变动时
// 模型可以靠它重新定位。
// ============================================================================

import { diffLines } from 'diff';

/** 摘录上限：够模型重新定位一个块，又不把反馈消息灌成整文件转储。 */
const EXCERPT_MAX_LINES = 12;

export interface TurnDiffHunk {
  /** 本文件内的块序号（1-based，展示用） */
  index: number;
  /** 新文件 1-based 起始行（纯删除块：被删内容所在的那一行） */
  startLine: number;
  /** 新文件 1-based 结束行（含；纯删除块与 startLine 相同） */
  endLine: number;
  /** 块内新增行数 */
  added: number;
  /** 块内删除行数 */
  removed: number;
  /** 块内 diff 行（`-`/`+` 前缀），最多 12 行 */
  excerpt: string;
}

function lineCount(value: string): number {
  if (value === '') return 0;
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0);
}

/** diff 的 value 以 '\n' 结尾是常态；split 后丢掉末尾空串，行数才对得上。 */
function toLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 连续的 added/removed 变更段算一个块；中间隔着未变上下文就分块。
 * 返回空数组 = 文件无改动（或改动后逐行一致）。
 */
export function buildTurnDiffHunks(oldText: string, newText: string): TurnDiffHunk[] {
  const hunks: TurnDiffHunk[] = [];
  const totalNewLines = lineCount(newText);

  let newLine = 1; // 新文件 1-based 行游标
  let startLine: number | null = null;
  let endLine: number | null = null;
  let added = 0;
  let removed = 0;
  const excerptLines: string[] = [];

  const flush = (): void => {
    if (startLine === null && added === 0 && removed === 0) return;
    // 纯删除块没有新文件行区间：记被删内容所在的那一行（夹到文件长度内）
    if (startLine === null) {
      const pos = Math.min(Math.max(newLine, 1), Math.max(totalNewLines, 1));
      startLine = pos;
    }
    hunks.push({
      index: hunks.length + 1,
      startLine,
      endLine: endLine ?? startLine,
      added,
      removed,
      excerpt: excerptLines.slice(0, EXCERPT_MAX_LINES).join('\n'),
    });
    startLine = null;
    endLine = null;
    added = 0;
    removed = 0;
    excerptLines.length = 0;
  };

  for (const change of diffLines(oldText, newText)) {
    if (!change.added && !change.removed) {
      flush();
      newLine += lineCount(change.value);
      continue;
    }
    const count = change.count ?? lineCount(change.value);
    if (change.removed) {
      removed += count;
      excerptLines.push(...toLines(change.value).map((line) => `-${line}`));
    }
    if (change.added) {
      added += count;
      if (startLine === null) startLine = newLine;
      newLine += count;
      endLine = newLine - 1;
      excerptLines.push(...toLines(change.value).map((line) => `+${line}`));
    }
  }
  flush();

  return hunks;
}
