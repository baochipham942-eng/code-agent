// 画布删除快捷键的纯路由逻辑（无 DOM 依赖，可单测）。
// Mac 主键盘 Delete 在浏览器事件里通常是 Backspace；外接/扩展键盘的 forward delete 是 Delete。

export interface CanvasDeleteKeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  targetTag?: string;
  targetEditable?: boolean;
}

export interface CanvasDeleteOpts {
  annotMode: boolean;
  comparing: boolean;
  selectedCount: number;
}

export function shouldHandleCanvasDelete(e: CanvasDeleteKeyEventLike, opts: CanvasDeleteOpts): boolean {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.isComposing) return false;
  const tag = e.targetTag;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.targetEditable) return false;
  if (opts.comparing || opts.annotMode) return false;
  return opts.selectedCount > 0;
}

export function dispatchCanvasDeleteKey(
  e: CanvasDeleteKeyEventLike,
  opts: CanvasDeleteOpts,
  handlers: { deleteSelected: () => void },
): boolean {
  if (!shouldHandleCanvasDelete(e, opts)) return false;
  handlers.deleteSelected();
  return true;
}
