// @vitest-environment jsdom
// ============================================================================
// 文字流内联 chip（WorkBuddy phrase chip 模型）：
// 纯 DOM 模型层 + InputArea（contenteditable）交互
// ============================================================================

import React, { createRef, forwardRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  chipMountAfterCaret,
  chipMountBeforeCaret,
  createChipMount,
  deletePlainTextRange,
  extractComposerPlainText,
  getCaretPlainTextOffset,
  insertChipAtPlainOffset,
  listChipMounts,
  replaceRangeWithChipMount,
  setCaretPlainTextOffset,
  syncChipMounts,
  type InlineChipRef,
} from '../../../src/renderer/components/features/chat/ChatInput/composerRichTextModel';
import {
  InputArea,
  type InputAreaProps,
  type InputAreaRef,
} from '../../../src/renderer/components/features/chat/ChatInput/InputArea';
import type { InlineChipView } from '../../../src/renderer/components/features/chat/ChatInput/InlineComposerChip';

function setSelection(node: Node, offset: number): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('no selection');
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function buildRoot(...children: Array<Node>): HTMLElement {
  const root = document.createElement('div');
  for (const child of children) root.appendChild(child);
  document.body.appendChild(root);
  return root;
}

const goalChip: InlineChipRef = { key: 'command:goal', kind: 'command', id: 'goal' };

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('composerRichTextModel', () => {
  it('提取纯文本时跳过 chip 内容，只拼接文本节点', () => {
    const mount = createChipMount(goalChip);
    mount.textContent = '设定目标';
    const root = buildRoot(document.createTextNode('开始'), mount, document.createTextNode('做xxx'));

    expect(extractComposerPlainText(root)).toBe('开始做xxx');
  });

  it('光标纯文本偏移与 chip 混排时往返一致', () => {
    const mount = createChipMount(goalChip);
    const root = buildRoot(document.createTextNode('开始'), mount, document.createTextNode('做xxx'));

    setCaretPlainTextOffset(root, 3); // 「做」之后
    expect(getCaretPlainTextOffset(root)).toBe(3);

    setCaretPlainTextOffset(root, 2); // chip 之后第一个字符前
    expect(getCaretPlainTextOffset(root)).toBe(2);
  });

  it('触发词替换：删除区间、原位插入 chip、光标落在 chip 后', () => {
    const root = buildRoot(document.createTextNode('开始/goal做'));

    const mount = replaceRangeWithChipMount(root, 2, 7, goalChip);

    expect(extractComposerPlainText(root)).toBe('开始做');
    expect(listChipMounts(root)).toHaveLength(1);
    // chip 位于「开始」与「做」之间
    expect(root.childNodes[1]).toBe(mount);
    // 光标落在 chip 后：Backspace 应命中这颗 chip
    expect(chipMountBeforeCaret(root)).toBe(mount);
  });

  it('Backspace/Delete 边界：只在紧贴 chip 时命中', () => {
    const mount = createChipMount(goalChip);
    const root = buildRoot(document.createTextNode('ab'), mount, document.createTextNode('cd'));

    // 光标在文本中间 → 不命中
    setSelection(root.childNodes[0], 1);
    expect(chipMountBeforeCaret(root)).toBeNull();
    expect(chipMountAfterCaret(root)).toBeNull();

    // 光标在文本末尾（chip 之前）：Backspace 删文本字符，Delete 删 chip
    setSelection(root.childNodes[0], 2);
    expect(chipMountBeforeCaret(root)).toBeNull();
    expect(chipMountAfterCaret(root)).toBe(mount);

    // 光标在 chip 之后的文本开头 → Backspace 命中 chip
    setSelection(root.childNodes[2], 0);
    expect(chipMountBeforeCaret(root)).toBe(mount);

    // 光标在编辑区层级、chip 之后 → Backspace 命中 chip
    setSelection(root, 2);
    expect(chipMountBeforeCaret(root)).toBe(mount);
  });

  it('store → DOM 对账：多余挂载点摘除、缺失的补到末尾', () => {
    const stale = createChipMount({ key: 'skill:old', kind: 'skill', id: 'old' });
    const root = buildRoot(document.createTextNode('文本'), stale);

    syncChipMounts(root, [goalChip, { key: 'file:a1', kind: 'file', id: 'a1' }]);

    const keys = listChipMounts(root).map((m) => m.getAttribute('data-composer-chip-key'));
    expect(keys).toEqual(['command:goal', 'file:a1']);
    expect(extractComposerPlainText(root)).toBe('文本');
  });

  it('删除含换行的区间', () => {
    const root = buildRoot(document.createTextNode('甲\n乙\n丙'));
    deletePlainTextRange(root, 1, 4);
    expect(extractComposerPlainText(root)).toBe('甲丙');
  });

  it('在文本节点中途插入 chip 会断开文本节点', () => {
    const root = buildRoot(document.createTextNode('开始做'));
    insertChipAtPlainOffset(root, 2, goalChip);
    expect(extractComposerPlainText(root)).toBe('开始做');
    expect(root.childNodes).toHaveLength(3);
    expect(root.childNodes[1]).toBe(listChipMounts(root)[0]);
  });
});

// ---------------------------------------------------------------------------
// InputArea（contenteditable）交互
// ---------------------------------------------------------------------------

const skillChipView: InlineChipView = { key: 'skill:docx', kind: 'skill', id: 'docx', label: 'docx' };

const Harness = forwardRef<InputAreaRef, Partial<InputAreaProps> & { initialValue?: string }>(function Harness(props, ref) {
  const { initialValue = '', ...rest } = props;
  const [value, setValue] = useState(initialValue);
  return (
    <InputArea
      ref={ref}
      value={value}
      onChange={(next) => { setValue(next); props.onChange?.(next); }}
      onSubmit={props.onSubmit ?? vi.fn()}
      onFileSelect={vi.fn()}
      isFocused={false}
      onFocusChange={vi.fn()}
      {...rest}
    />
  );
});

function getEditor(): HTMLElement {
  return screen.getByTestId('chat-composer-textarea');
}

describe('InputArea 内联 chip', () => {
  it('chip 内联渲染在文字流里（portal 挂载点），纯文本不含 chip 文案', () => {
    render(<Harness initialValue="开始用" inlineChips={[skillChipView]} />);

    const editor = getEditor();
    // chip 标签内联在编辑区里
    expect(screen.getByText('docx')).toBeTruthy();
    expect(editor.getAttribute('data-plain-text')).toBe('开始用');
    expect(extractComposerPlainText(editor)).toBe('开始用');
    // 无光标来源的 chip 补到文本末尾
    expect(editor.lastChild).toBe(listChipMounts(editor)[0]);
  });

  it('Backspace 紧贴 chip：删 chip 并回调移除（不是删文本）', () => {
    const onRemoveInlineChip = vi.fn();
    render(<Harness initialValue="" inlineChips={[skillChipView]} onRemoveInlineChip={onRemoveInlineChip} />);

    const editor = getEditor();
    const mount = listChipMounts(editor)[0];
    expect(mount).toBeTruthy();
    // 光标放在 chip 之后
    setSelection(editor, Array.prototype.indexOf.call(editor.childNodes, mount) + 1);
    fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(onRemoveInlineChip).toHaveBeenCalledWith(skillChipView);
    expect(listChipMounts(editor)).toHaveLength(0);
  });

  it('Backspace 在文本中间：不碰 chip', () => {
    const onRemoveInlineChip = vi.fn();
    render(<Harness initialValue="甲乙" inlineChips={[skillChipView]} onRemoveInlineChip={onRemoveInlineChip} />);

    const editor = getEditor();
    setSelection(editor.childNodes[0], 1);
    fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(onRemoveInlineChip).not.toHaveBeenCalled();
    expect(listChipMounts(editor)).toHaveLength(1);
  });

  it('触发词替换（ref.replaceRangeWithChip）：文本去掉触发词、chip 落原位', () => {
    const onChange = vi.fn();
    const ref = createRef<InputAreaRef>();
    render(<Harness ref={ref} initialValue="帮我 /go" onChange={onChange} />);

    act(() => {
      ref.current?.replaceRangeWithChip(3, 7, goalChip);
    });

    expect(onChange).toHaveBeenLastCalledWith('帮我 ');
    const editor = getEditor();
    expect(listChipMounts(editor)).toHaveLength(1);
    expect(extractComposerPlainText(editor)).toBe('帮我 ');
  });

  it('发送后清空：外部 value 置空 + chip 清单清空 → 编辑区归空', () => {
    function ClearHarness() {
      const [value, setValue] = useState('做xxx');
      const [chips, setChips] = useState<InlineChipView[]>([skillChipView]);
      return (
        <>
          <button data-testid="clear" onClick={() => { setValue(''); setChips([]); }} />
          <InputArea
            value={value}
            onChange={setValue}
            onSubmit={vi.fn()}
            onFileSelect={vi.fn()}
            isFocused={false}
            onFocusChange={vi.fn()}
            inlineChips={chips}
          />
        </>
      );
    }
    render(<ClearHarness />);

    fireEvent.click(screen.getByTestId('clear'));

    const editor = getEditor();
    expect(extractComposerPlainText(editor)).toBe('');
    expect(listChipMounts(editor)).toHaveLength(0);
  });

  it('浏览器侧删了 chip（框选删除/剪切）：input 事件回传现存 chip key', () => {
    const onInlineChipsChanged = vi.fn();
    render(<Harness initialValue="文字" inlineChips={[skillChipView]} onInlineChipsChanged={onInlineChipsChanged} />);

    const editor = getEditor();
    listChipMounts(editor)[0].remove();
    fireEvent.input(editor);

    expect(onInlineChipsChanged).toHaveBeenLastCalledWith([]);
  });

  it('Enter 发送（IME 三重防护）：keyCode 229 / 组合态不发，普通 Enter 发送', () => {
    const onSubmit = vi.fn();
    render(<Harness initialValue="你好" onSubmit={onSubmit} />);
    const editor = getEditor();

    // 普通 Enter → 发送
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 13 });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // IME 候选确认（keyCode 229）→ 不发送
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // composition 进行中 → 不发送
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(editor);

    // Shift+Enter 换行 → 不发送
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('粘贴纯文本（含换行）走纯文本插入并触发 onChange', () => {
    const onChange = vi.fn();
    render(<Harness initialValue="" onChange={onChange} />);
    const editor = getEditor();

    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === 'text/plain' ? '第一行\n第二行' : ''),
      },
    });

    expect(onChange).toHaveBeenLastCalledWith('第一行\n第二行');
    expect(extractComposerPlainText(editor)).toBe('第一行\n第二行');
  });

  it('删光文字后 WebKit 残留的占位 <br> 被清掉：值回 ""、placeholder 回来（真机 2026-08-05）', () => {
    const onChange = vi.fn();
    render(<Harness initialValue="11" onChange={onChange} placeholder="继续描述…" />);

    const editor = getEditor();
    // 模拟 WebKit 删光后的 DOM 终态：文本没了，只剩一个占位 <br>
    editor.replaceChildren(document.createElement('br'));
    fireEvent.input(editor);

    expect(onChange).toHaveBeenLastCalledWith('');
    expect(editor.childNodes.length).toBe(0);
    expect(editor.getAttribute('data-plain-text')).toBe('');
    expect(screen.getByText('继续描述…')).toBeTruthy();
  });
});
