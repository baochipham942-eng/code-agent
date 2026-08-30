// ============================================================================
// tui-app/editor.ts — 多行编辑器状态机 / 粘贴 chip / 历史 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  applyPaste,
  backspace,
  computeWindow,
  content,
  createEditorState,
  displayWidth,
  expandedContent,
  insertNewline,
  insertText,
  isChipMarker,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  PASTE_CHIP_MIN_BYTES,
  PromptHistory,
  shouldChipPaste,
  visualRowCount,
  withContent,
} from '../../../../src/cli/tui-app/editorState';

describe('insertText / insertNewline / 光标行列', () => {
  it('单行插入与光标移动', () => {
    let state = createEditorState();
    state = insertText(state, 'hello');
    expect(state.lines).toEqual(['hello']);
    expect(state.cursorCol).toBe(5);
    state = moveLeft(state);
    state = insertText(state, 'X');
    expect(content(state)).toBe('hellXo');
  });

  it('含换行的插入拆成逻辑行', () => {
    let state = createEditorState();
    state = insertText(state, 'ab\ncd\nef');
    expect(state.lines).toEqual(['ab', 'cd', 'ef']);
    expect(state.cursorRow).toBe(2);
    expect(state.cursorCol).toBe(2);
  });

  it('insertNewline 在光标处拆行', () => {
    let state = createEditorState();
    state = insertText(state, 'abcd');
    state = moveLeft(state);
    state = moveLeft(state);
    state = insertNewline(state);
    expect(state.lines).toEqual(['ab', 'cd']);
    expect(state.cursorRow).toBe(1);
    expect(state.cursorCol).toBe(0);
  });

  it('上下方向键在多行间移动并钳制列', () => {
    let state = createEditorState();
    state = insertText(state, 'long line\nx');
    // 光标在 'x' 末尾 (row=1, col=1)
    state = moveUp(state);
    expect(state.cursorRow).toBe(0);
    expect(state.cursorCol).toBe(1); // 钳制不越界
    state = moveDown(state);
    expect(state.cursorRow).toBe(1);
    state = moveUp(state);
    state = moveUp(state); // 已在首行，不动
    expect(state.cursorRow).toBe(0);
  });

  it('moveLeft/Right 跨行', () => {
    let state = createEditorState();
    state = insertText(state, 'ab\ncd');
    state = moveUp(state); // row0，col 钳制到 min(2, 2) = 2
    expect(state.cursorRow).toBe(0);
    expect(state.cursorCol).toBe(2);
    state = moveRight(state); // 行尾 → 下一行行首
    expect(state.cursorRow).toBe(1);
    expect(state.cursorCol).toBe(0);
    state = moveLeft(state); // 回上一行行尾
    expect(state.cursorRow).toBe(0);
    expect(state.cursorCol).toBe(2);
  });
});

describe('backspace', () => {
  it('行首退格合并上一行', () => {
    let state = createEditorState();
    state = insertText(state, 'ab\ncd');
    state = moveUp(state);
    state = moveDown(state); // row1 col0? moveDown 钳制 col → min(1, 2)=1... 直接定位
    state = { ...state, cursorRow: 1, cursorCol: 0 };
    state = backspace(state);
    expect(state.lines).toEqual(['abcd']);
    expect(state.cursorRow).toBe(0);
    expect(state.cursorCol).toBe(2);
  });

  it('空文档退格是 no-op', () => {
    const state = backspace(createEditorState());
    expect(state.lines).toEqual(['']);
  });
});

describe('粘贴 chip', () => {
  it('阈值：3 行内联，4 行折叠，≥10KB 折叠', () => {
    expect(shouldChipPaste('a\nb\nc')).toBe(false);
    expect(shouldChipPaste('a\nb\nc\nd')).toBe(true);
    expect(shouldChipPaste('x'.repeat(PASTE_CHIP_MIN_BYTES))).toBe(true);
  });

  it('短粘贴直接内联', () => {
    let state = createEditorState();
    state = applyPaste(state, 'line1\nline2\nline3');
    expect(content(state)).toBe('line1\nline2\nline3');
    expect(Object.keys(state.chips)).toHaveLength(0);
  });

  it('大粘贴折叠成 marker，提交时展开回原文', () => {
    const pasted = Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n');
    let state = createEditorState();
    state = insertText(state, '请看 ');
    state = applyPaste(state, pasted);
    expect(Object.keys(state.chips)).toHaveLength(1);
    const marker = Object.keys(state.chips)[0];
    expect(isChipMarker(marker)).toBe(true);
    expect(content(state)).toBe(`请看 ${marker}`);
    expect(state.chips[marker].lineCount).toBe(10);
    expect(expandedContent(state)).toBe(`请看 ${pasted}`);
  });

  it('chip marker 按原子退格删除并注销', () => {
    const pasted = 'a\nb\nc\nd';
    let state = createEditorState();
    state = applyPaste(state, pasted);
    expect(content(state).length).toBe(1); // 只有 marker
    state = backspace(state);
    expect(content(state)).toBe('');
    expect(Object.keys(state.chips)).toHaveLength(0);
  });

  it('withContent 重置后光标落在末尾', () => {
    let state = createEditorState();
    state = withContent(state, 'abc\ndef');
    expect(state.cursorRow).toBe(1);
    expect(state.cursorCol).toBe(3);
  });
});

describe('displayWidth / visualRowCount / computeWindow', () => {
  it('CJK 按 2 列', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('中a')).toBe(3);
  });

  it('visualRowCount 软换行估算', () => {
    expect(visualRowCount('', 10)).toBe(1);
    expect(visualRowCount('abcde', 10)).toBe(1);
    expect(visualRowCount('a'.repeat(21), 10)).toBe(3);
  });

  it('窗口不超过 maxRows 且光标行可见', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const win = computeWindow(lines, 19, 80, 10);
    expect(win.endRow).toBe(20);
    expect(win.endRow - win.startRow).toBe(10);
    expect(win.startRow).toBeLessThanOrEqual(19);

    // 光标在上部时窗口跟上
    const win2 = computeWindow(lines, 3, 80, 10);
    expect(win2.startRow).toBeLessThanOrEqual(3);
    expect(win2.endRow).toBeGreaterThan(3);
  });
});

describe('PromptHistory', () => {
  it('push/翻页/恢复 tempBuffer', () => {
    const history = new PromptHistory();
    history.push('first');
    history.push('second');
    expect(history.prev('')).toBe('second');
    expect(history.prev('second')).toBe('first');
    expect(history.prev('first')).toBe('first'.length ? null : null); // 已在最老
    expect(history.next()).toBe('second');
    expect(history.next()).toBe(''); // 恢复翻历史前的草稿
  });

  it('100 条上限，老的被淘汰', () => {
    const history = new PromptHistory();
    for (let i = 0; i < 120; i++) history.push(`cmd-${i}`);
    // 最老应是 cmd-20
    let text: string | null = null;
    let current = '';
    while (true) {
      const prev = history.prev(current);
      if (prev === null) break;
      text = prev;
      current = prev;
    }
    expect(text).toBe('cmd-20');
  });

  it('空串不入历史', () => {
    const history = new PromptHistory();
    history.push('   ');
    expect(history.prev('')).toBeNull();
  });
});
