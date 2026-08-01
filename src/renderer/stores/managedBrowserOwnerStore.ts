import { create } from 'zustand';

// 托管浏览器归属 + 浏览器现场 auto-open 的边沿判定。
//
// 两条信号源，精度不同：
//
// 1. **browser surface 会话**（B1-R·R2 升级后的主路径）。SurfaceSessionManager 的会话
//    自带 conversationId，是 host 给的**真归属**，不是猜的。agent 自己开浏览器走这条。
//    auto-open 只认这条——「agent 开了浏览器」才该抢焦点。
// 2. **托管浏览器 IPC 会话状态**（B1·S4 退化路径，保留）。host 侧托管浏览器是 agentId
//    维度的池（browserPool），IPC 入口拿的是默认单例，与 chat sessionId 零绑定，所以
//    用户在 LocalOps 手动 launch 时只能靠 renderer 记账猜归属。这条**不再触发 auto-open**
//    （用户手动开的时候注意力本来就在 LocalOps，抢过去反而打断），只用于归属标注兜底。
//
// 运行时真正 per-session 化仍是架构级改动（要 ADR），本单不做。

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
  /** 启动这扇窗时的前台 chat 会话 id（退化路径的猜测值） */
  ownerSessionId: string | null;
  /** 是否已经观察过至少一次会话状态（用于区分「真的启动了」和「挂载时它已经在跑」） */
  observed: boolean;
  /** 上一次观察到的活跃 browser surface 会话 id；用于 auto-open 边沿去重 */
  browserSurfaceSessionId: string | null;
  /**
   * 记录一次托管浏览器 IPC 状态观察（只更新归属标注，不再驱动 auto-open）。
   */
  noteManagedBrowserSession: (observation: ManagedBrowserSessionObservation) => void;
  /**
   * 记录一次 browser surface 会话观察，返回是否构成「新会话启动」——即调用方是否该
   * 请求 auto-open。同一会话重复观察返回 false，多个 hook 消费者同时观察也只有一个
   * 拿到 true。
   */
  noteBrowserSurfaceSession: (surfaceSessionId: string | null) => boolean;
  resetManagedBrowserOwnerForTests: () => void;
}

export const useManagedBrowserOwnerStore = create<ManagedBrowserOwnerState>((set, get) => ({
  browserSessionKey: null,
  ownerSessionId: null,
  observed: false,
  browserSurfaceSessionId: null,

  noteManagedBrowserSession: ({ running, browserSessionId, currentSessionId }) => {
    const nextKey = running ? (browserSessionId || RUNNING_WITHOUT_ID) : null;
    const { browserSessionKey, observed } = get();
    if (observed && browserSessionKey === nextKey) {
      return;
    }
    set({
      browserSessionKey: nextKey,
      ownerSessionId: nextKey ? currentSessionId : null,
      observed: true,
    });
  },

  noteBrowserSurfaceSession: (surfaceSessionId) => {
    if (get().browserSurfaceSessionId === surfaceSessionId) {
      return false;
    }
    set({ browserSurfaceSessionId: surfaceSessionId });
    // 会话结束（变 null）不是启动，不抢焦点。
    return surfaceSessionId !== null;
  },

  resetManagedBrowserOwnerForTests: () => set({
    browserSessionKey: null,
    ownerSessionId: null,
    observed: false,
    browserSurfaceSessionId: null,
  }),
}));
