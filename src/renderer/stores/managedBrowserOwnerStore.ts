import { create } from 'zustand';

// 托管浏览器归属（B1 · S4 退化路径）。
//
// host 侧托管浏览器是 agentId 维度的池（browserPool），IPC 入口拿的是默认单例，
// **与 chat sessionId 没有任何绑定**。所以「哪个会话启动了这扇窗」只能在 renderer
// 侧记：会话状态首次变成 running 时，把当时的前台会话记为 owner。
// 运行时真正 per-session 化是架构级改动（要 ADR），本单不做。

/** running 但 host 没给 sessionId 时的占位键——仍能靠 running/stopped 切换重新武装。 */
const RUNNING_WITHOUT_ID = '__managed_browser_running__';

export interface ManagedBrowserSessionObservation {
  running: boolean;
  browserSessionId: string | null;
  currentSessionId: string | null;
}

interface ManagedBrowserOwnerState {
  /** 当前 running 托管浏览器的标识键；未运行为 null */
  browserSessionKey: string | null;
  /** 启动这扇窗时的前台 chat 会话 id */
  ownerSessionId: string | null;
  /** 是否已经观察过至少一次会话状态（用于区分「真的启动了」和「挂载时它已经在跑」） */
  observed: boolean;
  /**
   * 记录一次会话状态观察，返回是否构成「新启动」——即调用方是否该请求 auto-open。
   * 同一 running 会话重复观察返回 false，多个 hook 消费者同时观察也只会有一个拿到 true。
   */
  noteManagedBrowserSession: (observation: ManagedBrowserSessionObservation) => boolean;
  resetManagedBrowserOwnerForTests: () => void;
}

export const useManagedBrowserOwnerStore = create<ManagedBrowserOwnerState>((set, get) => ({
  browserSessionKey: null,
  ownerSessionId: null,
  observed: false,

  noteManagedBrowserSession: ({ running, browserSessionId, currentSessionId }) => {
    const nextKey = running ? (browserSessionId || RUNNING_WITHOUT_ID) : null;
    const { browserSessionKey, observed } = get();
    if (observed && browserSessionKey === nextKey) {
      return false;
    }
    set({
      browserSessionKey: nextKey,
      ownerSessionId: nextKey ? currentSessionId : null,
      observed: true,
    });
    // 挂载时它已经在跑（上次 app 生命周期留下的）不算本轮启动，不抢焦点。
    return observed && nextKey !== null;
  },

  resetManagedBrowserOwnerForTests: () => set({
    browserSessionKey: null,
    ownerSessionId: null,
    observed: false,
  }),
}));
