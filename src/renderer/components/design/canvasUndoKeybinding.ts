// 画布撤销/重做快捷键的纯路由逻辑（无 DOM 依赖，可单测）。
// DesignCanvas 的 keydown handler 只做薄分发，把"按键→动作"判断隔离在此便于覆盖各类边界。
//
// 边界（艾克斯审计）：
// - 输入边界（MED-4）：焦点在 input/textarea/contentEditable 或 IME 组合中→让出原生 undo。
// - 比较浮层（MED-2）：comparing 全覆盖浮层显示时不劫持 Cmd+Z，避免无感改画布。
// - 标注模式（HIGH-2）：标注模式下 Cmd+Z 不做画布 undo（半笔拖拽中 slice 会损坏上一笔），
//   标注笔画级撤销作为后续增量（需把 AnnotationLayer 的 drawing 状态上提后再做）。

export type CanvasUndoAction = 'undo' | 'redo' | 'none';

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

export interface CanvasUndoOpts {
  /** 标注重绘模式激活中。 */
  annotMode: boolean;
  /** 版本并排比较浮层显示中。 */
  comparing: boolean;
}

export function resolveCanvasUndoAction(e: KeyEventLike, opts: CanvasUndoOpts): CanvasUndoAction {
  if (!(e.metaKey || e.ctrlKey)) return 'none';
  if (e.key.toLowerCase() !== 'z') return 'none';
  if (e.isComposing) return 'none';
  const tag = e.targetTag;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.targetEditable) return 'none';
  if (opts.comparing) return 'none'; // MED-2：比较浮层显示时让出
  if (opts.annotMode) return 'none'; // HIGH-2：标注模式不做画布 undo
  return e.shiftKey ? 'redo' : 'undo';
}

/** 撤销/重做的动作回调（由 DesignCanvas 注入真实 store 操作）。 */
export interface CanvasUndoHandlers {
  undo: () => void;
  redo: () => void;
}

/**
 * 把一次按键事件分发到对应回调。返回是否已处理（caller 据此 preventDefault）。
 * 路由判定委托 resolveCanvasUndoAction；本函数只做"动作→回调"映射，便于在无 DOM 下单测。
 */
export function dispatchCanvasUndoKey(e: KeyEventLike, opts: CanvasUndoOpts, h: CanvasUndoHandlers): boolean {
  const action = resolveCanvasUndoAction(e, opts);
  if (action === 'none') return false;
  if (action === 'undo') h.undo();
  else h.redo();
  return true;
}
