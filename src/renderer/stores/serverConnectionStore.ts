// ============================================================================
// Server Connection Store — 后台服务连接状态（N-WEBSERVER-DEATH-SUPERVISE-BANNER）
// ============================================================================
// 壳已经自动重启挂掉的 webServer（webserver_supervise.rs），renderer 这边只差让
// 用户看得见：服务死亡期间出「重连中」横幅，恢复后横幅自己消失。状态机本体在
// utils/serverConnectionMonitor.ts（探测 /api/health 的定时器与阈值判定），
// 这里只放横幅要读的那一格状态，一域一 store。
// ============================================================================

import { create } from 'zustand';

/**
 * ok          正常（初始态；短抖动期间也停留在这里，不出横幅）
 * recovering  连续探测失败达到阈值——顶部横幅「正在重连…」
 * unavailable 持续不可达超时——横幅升级为「无法恢复」+「重试」按钮
 */
type ServerConnectionStatus = 'ok' | 'recovering' | 'unavailable';

interface ServerConnectionState {
  status: ServerConnectionStatus;
  setStatus: (status: ServerConnectionStatus) => void;
}

export const useServerConnectionStore = create<ServerConnectionState>()((set) => ({
  status: 'ok',
  setStatus: (status) =>
    set((state) => (state.status === status ? state : { status })),
}));

/** 非组件调用方（httpTransport）读当前状态的入口。 */
export function getServerConnectionStatus(): ServerConnectionStatus {
  return useServerConnectionStore.getState().status;
}
