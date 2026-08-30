// ============================================================================
// Ink TUI 多行编辑器状态机（纯函数，无 Ink 依赖，可单测）
// - 逻辑行模型：lines[] + (cursorRow, cursorCol)，渲染层负责软换行
// - 粘贴 chip：≥4 行或 ≥10KB 折叠成 marker 字符（私用区 U+E000+），
//   光标经过/退格按原子处理，提交时 expandedContent 展开回原文
// - 历史：沿用 tui/inputManager 的 100 条内存历史模式（tempBuffer 恢复）
// ============================================================================

// ---------------------------------------------------------------------------
// 粘贴 chip
// ---------------------------------------------------------------------------

/** chip 折叠阈值（对齐交互规格：≥4 行或 ≥10KB） */
const PASTE_CHIP_MIN_LINES = 4;
export const PASTE_CHIP_MIN_BYTES = 10 * 1024;

/** chip marker 用 Unicode 私用区单字符，光标/退格天然按原子处理 */
const CHIP_MARKER_BASE = 0xe000;
const CHIP_MARKER_MAX = 0xe0ff;

interface PasteChip {
  marker: string;
  text: string;
  lineCount: number;
}

export function isChipMarker(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= CHIP_MARKER_BASE && code <= CHIP_MARKER_MAX;
}

/** 是否应折叠成 chip（≥4 行或 ≥10KB） */
export function shouldChipPaste(text: string): boolean {
  if (text.length >= PASTE_CHIP_MIN_BYTES) return true;
  return text.split('\n').length >= PASTE_CHIP_MIN_LINES;
}

// ---------------------------------------------------------------------------
// 编辑器状态
// ---------------------------------------------------------------------------

export interface EditorState {
  lines: string[];
  cursorRow: number;
  /** UTF-16 码元偏移（与 string.slice 一致） */
  cursorCol: number;
  /** marker 字符 → chip 原文 */
  chips: Record<string, PasteChip>;
}

export function createEditorState(): EditorState {
  return { lines: [''], cursorRow: 0, cursorCol: 0, chips: {} };
}

/** 完整内容（含 chip marker） */
export function content(state: EditorState): string {
  return state.lines.join('\n');
}

/** 提交用内容：chip marker 展开回原文 */
export function expandedContent(state: EditorState): string {
  let text = content(state);
  for (const chip of Object.values(state.chips)) {
    text = text.split(chip.marker).join(chip.text);
  }
  return text;
}

export function isEmpty(state: EditorState): boolean {
  return content(state).trim().length === 0;
}

/** 用整段文本重置编辑器（历史回翻 / 采纳 slash 命令用） */
export function withContent(state: EditorState, text: string): EditorState {
  const lines = text.split('\n');
  const lastRow = lines.length - 1;
  return {
    lines,
    cursorRow: lastRow,
    cursorCol: lines[lastRow].length,
    chips: state.chips, // 已有 chip 的 marker 不在 text 里就自然失效，无需清理
  };
}

/** 插入文本（可含 \n，自动拆成逻辑行） */
export function insertText(state: EditorState, text: string): EditorState {
  const parts = text.split('\n');
  const before = state.lines[state.cursorRow].slice(0, state.cursorCol);
  const after = state.lines[state.cursorRow].slice(state.cursorCol);
  const lines = [
    ...state.lines.slice(0, state.cursorRow),
    before + parts[0],
    ...parts.slice(1, -1),
    // 单段插入没有独立尾行（head 已含 after 的拼接在下方处理）
    ...(parts.length > 1 ? [parts[parts.length - 1] + after] : []),
    ...state.lines.slice(state.cursorRow + 1),
  ];
  // 单段时 head 后还要接回 after
  if (parts.length === 1) {
    lines[state.cursorRow] = before + parts[0] + after;
  }
  const cursorRow = state.cursorRow + parts.length - 1;
  const cursorCol = parts.length === 1 ? state.cursorCol + parts[0].length : parts[parts.length - 1].length;
  return { ...state, lines, cursorRow, cursorCol };
}

/** 插入换行（Shift+Enter / Ctrl+J / `\` 续行） */
export function insertNewline(state: EditorState): EditorState {
  return insertText(state, '\n');
}

/** 退格：行首则与上一行合并；chip marker 按原子删除并注销 chip */
export function backspace(state: EditorState): EditorState {
  if (state.cursorCol === 0) {
    if (state.cursorRow === 0) return state;
    const prevLine = state.lines[state.cursorRow - 1];
    const lines = [
      ...state.lines.slice(0, state.cursorRow - 1),
      prevLine + state.lines[state.cursorRow],
      ...state.lines.slice(state.cursorRow + 1),
    ];
    return { ...state, lines, cursorRow: state.cursorRow - 1, cursorCol: prevLine.length };
  }
  const line = state.lines[state.cursorRow];
  const removed = line[state.cursorCol - 1];
  const chips = { ...state.chips };
  if (isChipMarker(removed)) {
    delete chips[removed];
  }
  const lines = [
    ...state.lines.slice(0, state.cursorRow),
    line.slice(0, state.cursorCol - 1) + line.slice(state.cursorCol),
    ...state.lines.slice(state.cursorRow + 1),
  ];
  return { ...state, lines, chips, cursorCol: state.cursorCol - 1 };
}

export function moveLeft(state: EditorState): EditorState {
  if (state.cursorCol > 0) return { ...state, cursorCol: state.cursorCol - 1 };
  if (state.cursorRow > 0) {
    return { ...state, cursorRow: state.cursorRow - 1, cursorCol: state.lines[state.cursorRow - 1].length };
  }
  return state;
}

export function moveRight(state: EditorState): EditorState {
  const lineLength = state.lines[state.cursorRow].length;
  if (state.cursorCol < lineLength) return { ...state, cursorCol: state.cursorCol + 1 };
  if (state.cursorRow < state.lines.length - 1) {
    return { ...state, cursorRow: state.cursorRow + 1, cursorCol: 0 };
  }
  return state;
}

export function moveUp(state: EditorState): EditorState {
  if (state.cursorRow === 0) return state;
  const cursorRow = state.cursorRow - 1;
  return { ...state, cursorRow, cursorCol: Math.min(state.cursorCol, state.lines[cursorRow].length) };
}

export function moveDown(state: EditorState): EditorState {
  if (state.cursorRow >= state.lines.length - 1) return state;
  const cursorRow = state.cursorRow + 1;
  return { ...state, cursorRow, cursorCol: Math.min(state.cursorCol, state.lines[cursorRow].length) };
}

export function moveHome(state: EditorState): EditorState {
  return { ...state, cursorCol: 0 };
}

export function moveEnd(state: EditorState): EditorState {
  return { ...state, cursorCol: state.lines[state.cursorRow].length };
}

/** 应用粘贴：达阈值折叠成 chip marker，否则内联插入 */
export function applyPaste(state: EditorState, text: string): EditorState {
  if (!shouldChipPaste(text)) {
    return insertText(state, text);
  }
  // 分配一个未占用的 marker
  let marker = '';
  for (let code = CHIP_MARKER_BASE; code <= CHIP_MARKER_MAX; code++) {
    const candidate = String.fromCodePoint(code);
    if (!state.chips[candidate]) {
      marker = candidate;
      break;
    }
  }
  if (!marker) {
    // marker 耗尽（256 个 chip），降级为内联
    return insertText(state, text);
  }
  const chip: PasteChip = { marker, text, lineCount: text.split('\n').length };
  const next = insertText(state, marker);
  return { ...next, chips: { ...next.chips, [marker]: chip } };
}

// ---------------------------------------------------------------------------
// 显示宽度与窗口裁剪（编辑器高度随内容伸缩，上限 maxRows）
// ---------------------------------------------------------------------------

/** 显示宽度：CJK/全角按 2 列，其余按 1 列（1 列宽字形保证布局不抖动） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide = code >= 0x1100 && (
      code <= 0x115f // Hangul Jamo
      || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f64f)
      || (code >= 0x20000 && code <= 0x3fffd)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

/** 一个逻辑行软换行后占的视觉行数 */
export function visualRowCount(line: string, width: number): number {
  const w = Math.max(width, 1);
  return Math.max(1, Math.ceil(displayWidth(line) / w));
}

/**
 * 计算可见逻辑行窗口：总视觉行数 ≤ maxRows 且光标行必须可见。
 * 从光标行出发先向下扩、再向上扩，保证底部（最新内容 + 光标）优先。
 */
export function computeWindow(
  lines: string[],
  cursorRow: number,
  width: number,
  maxRows: number,
): { startRow: number; endRow: number } {
  if (lines.length === 0) return { startRow: 0, endRow: 0 };
  let startRow = cursorRow;
  let endRow = cursorRow + 1;
  let budget = maxRows - visualRowCount(lines[cursorRow], width);
  if (budget < 0) budget = 0; // 光标行自身超 maxRows：只显示光标行（渲染层软换行兜底）

  // 向下扩（光标下面的行）
  while (endRow < lines.length) {
    const cost = visualRowCount(lines[endRow], width);
    if (cost > budget) break;
    budget -= cost;
    endRow++;
  }
  // 向上扩（光标上面的行）
  while (startRow > 0) {
    const cost = visualRowCount(lines[startRow - 1], width);
    if (cost > budget) break;
    budget -= cost;
    startRow--;
  }
  return { startRow, endRow };
}

// ---------------------------------------------------------------------------
// 提示历史（沿用 tui/inputManager 的 100 条内存模式）
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 100;

export class PromptHistory {
  private entries: string[] = [];
  private index = -1;
  private tempBuffer = '';

  /** 提交时记录（空串不记），重置浏览位置 */
  push(text: string): void {
    if (text.trim()) {
      this.entries.push(text);
      if (this.entries.length > HISTORY_LIMIT) this.entries.shift();
    }
    this.index = -1;
  }

  /** 往上翻：返回应装入编辑器的文本；到顶/无历史返回 null */
  prev(currentBuffer: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.index === -1) {
      this.tempBuffer = currentBuffer;
      this.index = this.entries.length - 1;
    } else if (this.index > 0) {
      this.index--;
    } else {
      return null; // 已在最老一条
    }
    return this.entries[this.index];
  }

  /** 往下翻：越过最新一条时恢复翻历史前的草稿 */
  next(): string | null {
    if (this.index === -1) return null;
    if (this.index < this.entries.length - 1) {
      this.index++;
      return this.entries[this.index];
    }
    this.index = -1;
    return this.tempBuffer;
  }

  get browsing(): boolean {
    return this.index !== -1;
  }

  /** Ctrl+R 历史搜索：子串匹配（大小写不敏感），新的在前；空 query 返回全部 */
  search(query: string): string[] {
    const newestFirst = [...this.entries].reverse();
    const q = query.trim().toLowerCase();
    if (!q) return newestFirst;
    return newestFirst.filter((entry) => entry.toLowerCase().includes(q));
  }
}
