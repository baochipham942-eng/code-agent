// 画布撤销/重做快捷键的纯路由逻辑（无 DOM 依赖，可单测）。
// DesignCanvas 的 keydown handler 只做薄分发，把"按键→动作"判断隔离在此便于覆盖输入边界。
//
// 输入边界（codex MED-4）：焦点在 input/textarea/contentEditable 或 IME 组合中时让出，
// 走浏览器原生 undo，不劫持。标注模式（codex MED-5）：Cmd+Z 撤一笔标注，不落到画布编辑；
// 标注不支持 redo（避免 Cmd+Shift+Z 误触画布 redo）。

export type CanvasUndoAction = 'undo' | 'redo' | 'annot-undo' | 'none';

/** 从真实 KeyboardEvent 抽取的最小判定输入（便于纯函数测试，不依赖 DOM）。 */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** IME 组合输入中（中文输入法）——此时不拦截。 */
  isComposing: boolean;
  /** 事件 target 的标签名（大写，如 'INPUT' / 'TEXTAREA'）。 */
  targetTag?: string;
  /** 事件 target 是否 contentEditable。 */
  targetEditable?: boolean;
}

export function resolveCanvasUndoAction(e: KeyEventLike, opts: { annotMode: boolean }): CanvasUndoAction {
  if (!(e.metaKey || e.ctrlKey)) return 'none';
  if (e.key.toLowerCase() !== 'z') return 'none';
  if (e.isComposing) return 'none';
  const tag = e.targetTag;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.targetEditable) return 'none';
  if (opts.annotMode) {
    // 标注模式：只支持撤一笔，不支持 redo。
    return e.shiftKey ? 'none' : 'annot-undo';
  }
  return e.shiftKey ? 'redo' : 'undo';
}
