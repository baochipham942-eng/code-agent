// ============================================================================
// Run Control Store —— 会话运行时控制面的跨面板投影（T1）
// ----------------------------------------------------------------------------
// steering 队列与中断都由 useAgent 拥有（只在 ChatView 里挂一次），而右栏
// Overview 是另一棵子树。这个 store 只做投影：useAgent 是唯一写入方，
// Overview 只读 + 回调。动作一律是 useAgent 里那几个既有实现（走 host
// QueuedInput / agent:cancel IPC），这里不重新实现任何一条链路。
// ============================================================================

import { create } from 'zustand';

export interface RunControlQueueItem {
  id: string;
  content: string;
  attachmentsCount: number;
  /** 发送失败后留在队列里的条目：只能删，不能再点发送 */
  sendFailed?: boolean;
}

export interface RunControlActions {
  /** = useAgent().cancel */
  interrupt: () => void | Promise<void>;
  /** = useAgent().cancelQueuedRuntimeInput（host QueuedInput retract） */
  retractQueued: (id: string) => void | Promise<void>;
  /** = useAgent().sendQueuedRuntimeInput（host markSending + steer/send） */
  sendQueuedNow: (id: string) => void | Promise<void>;
}

interface RunControlStore {
  queue: RunControlQueueItem[];
  /** null = 聊天运行时未挂载，Overview 不给动作按钮（不伪造可点入口） */
  actions: RunControlActions | null;
  publishQueue: (queue: RunControlQueueItem[]) => void;
  publishActions: (actions: RunControlActions | null) => void;
}

const EMPTY_QUEUE: RunControlQueueItem[] = [];

export const useRunControlStore = create<RunControlStore>()((set) => ({
  queue: EMPTY_QUEUE,
  actions: null,
  publishQueue: (queue) => set((state) => (
    // 空→空不写，避免每次 useAgent 重渲染都推一个新数组引起订阅者空转。
    state.queue.length === 0 && queue.length === 0 ? state : { queue }
  )),
  publishActions: (actions) => set({ actions }),
}));
