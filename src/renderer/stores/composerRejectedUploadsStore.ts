// ============================================================================
// Composer Rejected Uploads Store - 超限被拒附件的持久登记
// ============================================================================
// toast 会自己消失，输入框不留痕，用户会以为文件已随消息发出（FB-600）。
// 这里让被拒文件留在输入框上方，直到用户关掉、发送或切会话。
// 放共享 store 而不是 hook 调用方：输入框与全局拖拽两条入口共用 useFileUpload。
// ============================================================================

import { create } from 'zustand';

interface RejectedUpload {
  id: string;
  name: string;
  size: number;
}

interface RejectedUploadsState {
  items: RejectedUpload[];
  add: (item: Omit<RejectedUpload, 'id'>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let seq = 0;

export const useComposerRejectedUploadsStore = create<RejectedUploadsState>()((set) => ({
  items: [],
  add: (item) => set((s) => ({ items: [...s.items, { ...item, id: `rejected-${++seq}` }] })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set((s) => (s.items.length === 0 ? s : { items: [] })),
}));
