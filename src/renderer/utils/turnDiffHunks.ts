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
  /**
   * 新文件 1-based 起始行。有新增行的块 = 被改的行区间起点；
   * 纯删除块 = 删除位置的锚行，语义见 deletionAnchor。
   */
  startLine: number;
  /** 新文件 1-based 结束行（含；纯删除块与 startLine 相同） */
  endLine: number;
  /** 块内新增行数 */
  added: number;
  /** 块内删除行数 */
  removed: number;
  /** 块内 diff 行（`-`/`+` 前缀），最多 12 行（-/+ 两侧各留额度，见 capExcerpt） */
  excerpt: string;
  /**
   * 纯删除块（added === 0）的锚点语义；有新增行的块为 null。
   * - 'before'：中部删除——被删内容原本在 startLine 行之前，startLine 是删除后
   *   顶上来的存活行（它本身没被改过），恢复内容 = 在它之前插入；
   * - 'after'：文件尾删除——startLine = 新文件长度 + 1（最后一行之后的位置），
   *   绝不夹回最后一行：那行没被改过，夹回去会让模型去改它。
   */
  deletionAnchor: 'before' | 'after' | null;
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
 * 摘录封顶，-/+ 两侧都留额度：大段替换时 diffLines 先输出 removed 后输出 added，
 * 按顺序 slice(0, 12) 会全是 `-` 行、新增行一条进不了消息。只有一侧存在时它拿满额。
 */
function capExcerpt(minusLines: string[], plusLines: string[]): string {
  if (minusLines.length === 0 || plusLines.length === 0) {
    return [...minusLines, ...plusLines].slice(0, EXCERPT_MAX_LINES).join('\n');
  }
  let minus = Math.min(minusLines.length, Math.floor(EXCERPT_MAX_LINES / 2));
  const plus = Math.min(plusLines.length, EXCERPT_MAX_LINES - minus);
  minus = Math.min(minusLines.length, EXCERPT_MAX_LINES - plus); // 对方没用完的额度让回来
  return [...minusLines.slice(0, minus), ...plusLines.slice(0, plus)].join('\n');
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
  const minusLines: string[] = [];
  const plusLines: string[] = [];

  const flush = (): void => {
    if (startLine === null && added === 0 && removed === 0) return;
    let deletionAnchor: 'before' | 'after' | null = null;
    if (startLine === null) {
      // 纯删除块没有新文件行区间。锚行 = 删除位置的参照行：
      // 中部删除锚在顶上来的那行（'before'）；文件尾删除游标已越过新文件末尾，
      // 不夹回——夹回去的「最后一行」两边内容相同、从未被改，改它会指错地方。
      startLine = Math.max(newLine, 1);
      deletionAnchor = startLine > totalNewLines ? 'after' : 'before';
    }
    hunks.push({
      index: hunks.length + 1,
      startLine,
      endLine: endLine ?? startLine,
      added,
      removed,
      excerpt: capExcerpt(minusLines, plusLines),
      deletionAnchor,
    });
    startLine = null;
    endLine = null;
    added = 0;
    removed = 0;
    minusLines.length = 0;
    plusLines.length = 0;
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
      minusLines.push(...toLines(change.value).map((line) => `-${line}`));
    }
    if (change.added) {
      added += count;
      if (startLine === null) startLine = newLine;
      newLine += count;
      endLine = newLine - 1;
      plusLines.push(...toLines(change.value).map((line) => `+${line}`));
    }
  }
  flush();

  return hunks;
}
