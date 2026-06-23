import { describe, it, expect } from 'vitest';
import {
  resolveCanvasUndoAction,
  dispatchCanvasUndoKey,
  type KeyEventLike,
} from '@renderer/components/design/canvasUndoKeybinding';

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: 'z',
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  targetTag: 'DIV',
  targetEditable: false,
  ...over,
});

describe('resolveCanvasUndoAction', () => {
  it('Cmd+Z → undo', () => {
    expect(resolveCanvasUndoAction(ev({}), { annotMode: false })).toBe('undo');
  });

  it('Ctrl+Z（Win/Linux）→ undo', () => {
    expect(resolveCanvasUndoAction(ev({ metaKey: false, ctrlKey: true }), { annotMode: false })).toBe('undo');
  });

  it('Cmd+Shift+Z → redo', () => {
    expect(resolveCanvasUndoAction(ev({ shiftKey: true }), { annotMode: false })).toBe('redo');
  });

  it('大写 Z 也识别（shift 时 key 可能是大写）', () => {
    expect(resolveCanvasUndoAction(ev({ key: 'Z', shiftKey: true }), { annotMode: false })).toBe('redo');
  });

  it('无 meta/ctrl → none', () => {
    expect(resolveCanvasUndoAction(ev({ metaKey: false, ctrlKey: false }), { annotMode: false })).toBe('none');
  });

  it('非 z 键 → none', () => {
    expect(resolveCanvasUndoAction(ev({ key: 'a' }), { annotMode: false })).toBe('none');
  });

  it('IME 组合中（isComposing）→ none（codex MED-4）', () => {
    expect(resolveCanvasUndoAction(ev({ isComposing: true }), { annotMode: false })).toBe('none');
  });

  it('焦点在 INPUT → none，让原生 undo 工作（codex MED-4）', () => {
    expect(resolveCanvasUndoAction(ev({ targetTag: 'INPUT' }), { annotMode: false })).toBe('none');
  });

  it('焦点在 TEXTAREA → none（codex MED-4）', () => {
    expect(resolveCanvasUndoAction(ev({ targetTag: 'TEXTAREA' }), { annotMode: false })).toBe('none');
  });

  it('焦点在 contentEditable → none', () => {
    expect(resolveCanvasUndoAction(ev({ targetEditable: true }), { annotMode: false })).toBe('none');
  });

  it('标注模式 Cmd+Z → annot-undo（撤一笔标注，不落到画布编辑）', () => {
    expect(resolveCanvasUndoAction(ev({}), { annotMode: true })).toBe('annot-undo');
  });

  it('标注模式 Cmd+Shift+Z → none（标注不支持 redo，避免误触画布 redo）', () => {
    expect(resolveCanvasUndoAction(ev({ shiftKey: true }), { annotMode: true })).toBe('none');
  });

  it('标注模式下输入框内仍 none（输入边界优先于标注）', () => {
    expect(resolveCanvasUndoAction(ev({ targetTag: 'INPUT' }), { annotMode: true })).toBe('none');
  });
});

describe('dispatchCanvasUndoKey（动作→回调 分发胶水）', () => {
  const spies = () => {
    const calls: string[] = [];
    return {
      calls,
      handlers: {
        undo: () => calls.push('undo'),
        redo: () => calls.push('redo'),
        annotUndo: () => calls.push('annotUndo'),
      },
    };
  };

  it('undo 动作调 undo 回调并返回 true（应 preventDefault）', () => {
    const { calls, handlers } = spies();
    const handled = dispatchCanvasUndoKey(ev({}), { annotMode: false }, handlers);
    expect(handled).toBe(true);
    expect(calls).toEqual(['undo']);
  });

  it('redo 动作调 redo 回调', () => {
    const { calls, handlers } = spies();
    dispatchCanvasUndoKey(ev({ shiftKey: true }), { annotMode: false }, handlers);
    expect(calls).toEqual(['redo']);
  });

  it('标注模式调 annotUndo 回调', () => {
    const { calls, handlers } = spies();
    dispatchCanvasUndoKey(ev({}), { annotMode: true }, handlers);
    expect(calls).toEqual(['annotUndo']);
  });

  it('none 不调任何回调并返回 false（不 preventDefault，放行原生）', () => {
    const { calls, handlers } = spies();
    const handled = dispatchCanvasUndoKey(ev({ targetTag: 'INPUT' }), { annotMode: false }, handlers);
    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });
});
