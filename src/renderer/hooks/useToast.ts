// ============================================================================
// useToast - Global toast notification hook
// ============================================================================

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  /** 可选动作按钮（如「不再提示」）；点击后 toast 立即关闭 */
  action?: ToastAction;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number, action?: ToastAction) => void;
  removeToast: (id: string) => void;
}

let nextId = 0;

/**
 * 同一条 finding 重复几十遍的折叠（现象 11 渲染侧收敛）：
 * host 侧 `BRANCH_QUARANTINED: … has unresolved lineage findings: CODE, CODE, CODE …`
 * 会把同一个 code 按 issue 个数原样 join 进来，toast 一展开就是几十行一模一样的字。
 * 逐行按 ", " 切段，相邻同键段折叠成 `段 ×N`；段的键取「最后一个 `: ` 之后」的尾段，
 * 这样 `findings: CODE, CODE, …` 的第一段（带前缀）也能并进同一组。
 * 正常消息没有相邻同键段，原样通过。
 * 注意：这是症状治理——重复产生的根因在 host 侧（不归渲染改）。
 */
export function dedupeRepeatedListItems(message: string): string {
  const keyOf = (part: string): string => {
    const idx = part.lastIndexOf(': ');
    return idx >= 0 ? part.slice(idx + 2) : part;
  };
  return message
    .split('\n')
    .map((line) => {
      const parts = line.split(', ');
      const out: string[] = [];
      let i = 0;
      while (i < parts.length) {
        const key = keyOf(parts[i]);
        let j = i + 1;
        while (j < parts.length && keyOf(parts[j]) === key) j += 1;
        const count = j - i;
        out.push(count > 1 ? `${parts[i]} ×${count}` : parts[i]);
        i = j;
      }
      return out.join(', ');
    })
    .join('\n');
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (type, message, duration = 4000, action) => {
    const id = `toast-${++nextId}`;
    set((state) => ({
      toasts: [...state.toasts, { id, type, message: dedupeRepeatedListItems(message), duration, action }],
    }));
    // Auto-remove after duration
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, duration);
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

/** Convenience function for showing toasts (can be called from non-React code) */
export const toast = {
  success: (msg: string) => useToastStore.getState().addToast('success', msg),
  // action 可选：信任门这类「原地可修」的失败给一个动作按钮，别让用户跑到别处去解决
  error: (msg: string, action?: ToastAction, duration = 6000) =>
    useToastStore.getState().addToast('error', msg, duration, action),
  info: (msg: string) => useToastStore.getState().addToast('info', msg),
  warning: (msg: string, action?: ToastAction, duration = 5000) =>
    useToastStore.getState().addToast('warning', msg, duration, action),
};
