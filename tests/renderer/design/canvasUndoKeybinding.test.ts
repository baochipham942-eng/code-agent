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

const opts = (over?: Partial<{ annotMode: boolean; comparing: boolean }>) => ({
  annotMode: false,
  comparing: false,
  ...over,
});

describe('resolveCanvasUndoAction', () => {
  it('Cmd+Z → undo', () => {
    expect(resolveCanvasUndoAction(ev({}), opts())).toBe('undo');
  });

  it('Ctrl+Z（Win/Linux）→ undo', () => {
    expect(resolveCanvasUndoAction(ev({ metaKey: false, ctrlKey: true }), opts())).toBe('undo');
  });

  it('Cmd+Shift+Z → redo', () => {
    expect(resolveCanvasUndoAction(ev({ shiftKey: true }), opts())).toBe('redo');
  });

  it('大写 Z 也识别（shift 时 key 可能是大写）', () => {
    expect(resolveCanvasUndoAction(ev({ key: 'Z', shiftKey: true }), opts())).toBe('redo');
  });

  it('无 meta/ctrl → none', () => {
    expect(resolveCanvasUndoAction(ev({ metaKey: false, ctrlKey: false }), opts())).toBe('none');
  });

  it('非 z 键 → none', () => {
    expect(resolveCanvasUndoAction(ev({ key: 'a' }), opts())).toBe('none');
  });

  it('IME 组合中（isComposing）→ none（MED-4）', () => {
    expect(resolveCanvasUndoAction(ev({ isComposing: true }), opts())).toBe('none');
  });

  it('焦点在 INPUT → none，让原生 undo 工作（MED-4）', () => {
    expect(resolveCanvasUndoAction(ev({ targetTag: 'INPUT' }), opts())).toBe('none');
  });

  it('焦点在 TEXTAREA → none（MED-4）', () => {
    expect(resolveCanvasUndoAction(ev({ targetTag: 'TEXTAREA' }), opts())).toBe('none');
  });

  it('焦点在 contentEditable → none', () => {
    expect(resolveCanvasUndoAction(ev({ targetEditable: true }), opts())).toBe('none');
  });

  it('比较浮层显示时 → none（MED-2，不无感改画布）', () => {
    expect(resolveCanvasUndoAction(ev({}), opts({ comparing: true }))).toBe('none');
    expect(resolveCanvasUndoAction(ev({ shiftKey: true }), opts({ comparing: true }))).toBe('none');
  });

  it('标注模式 → none（HIGH-2，标注笔画级撤销延后，避免半笔损坏）', () => {
    expect(resolveCanvasUndoAction(ev({}), opts({ annotMode: true }))).toBe('none');
    expect(resolveCanvasUndoAction(ev({ shiftKey: true }), opts({ annotMode: true }))).toBe('none');
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
      },
    };
  };

  it('undo 动作调 undo 回调并返回 true（应 preventDefault）', () => {
    const { calls, handlers } = spies();
    const handled = dispatchCanvasUndoKey(ev({}), opts(), handlers);
    expect(handled).toBe(true);
    expect(calls).toEqual(['undo']);
  });

  it('redo 动作调 redo 回调', () => {
    const { calls, handlers } = spies();
    dispatchCanvasUndoKey(ev({ shiftKey: true }), opts(), handlers);
    expect(calls).toEqual(['redo']);
  });

  it('none 不调任何回调并返回 false（不 preventDefault，放行原生）', () => {
    const { calls, handlers } = spies();
    const handled = dispatchCanvasUndoKey(ev({ targetTag: 'INPUT' }), opts(), handlers);
    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });
});
