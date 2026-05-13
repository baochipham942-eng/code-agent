// ============================================================================
// Agent Registry Store - 渲染端 agents:list 缓存 + agents:changed 订阅
// ============================================================================
//
// 数据流：
// 1. 应用启动 → initializeAgentRegistryStore() 拉一次 agents:list 并订阅
//    IPC_CHANNELS.AGENTS_CHANGED 推送。
// 2. 主进程 chokidar 检测到 .md 变更 → 主进程 broadcast → 本 store 替换 entries。
// 3. UI 组件用 useAgentRegistryStore 订阅 entries，按 source 分组渲染。
//
// 活跃 agent 选择存在 appStore.activeAgentId（持久化到 localStorage），不与本 store
// 状态合并——本 store 只关心"系统里有哪些 agent 可选"。
// ============================================================================

import { create } from 'zustand';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { AgentListEntry, AgentsChangedEvent } from '@shared/contract/agentRegistry';
import { invokeDomain, on as ipcOn } from '../services/ipcService';

interface AgentRegistryState {
  /** 当前可用的 agent 列表（builtin + user + project 合并） */
  entries: AgentListEntry[];
  /** 首次加载是否完成 */
  isLoaded: boolean;
  /** 加载错误，UI 可显示 toast */
  loadError: string | null;

  /** Action：强制重新拉取列表（IPC agents:list） */
  refresh: () => Promise<void>;
  /** Action：直接替换列表（broadcast 推送时调用） */
  setEntries: (entries: AgentListEntry[]) => void;
}

export const useAgentRegistryStore = create<AgentRegistryState>((set) => ({
  entries: [],
  isLoaded: false,
  loadError: null,

  refresh: async () => {
    try {
      const entries = await invokeDomain<AgentListEntry[]>(IPC_DOMAINS.AGENT_REGISTRY, 'list');
      set({ entries: entries ?? [], isLoaded: true, loadError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ isLoaded: true, loadError: message });
       
      console.warn('[agentRegistryStore] refresh failed', message);
    }
  },

  setEntries: (entries) => set({ entries, isLoaded: true, loadError: null }),
}));

let unsubscribePush: (() => void) | undefined;

/**
 * 应用启动时调用：首次拉列表 + 订阅推送。
 * 多次调用会先取消旧订阅，避免重复回调。
 */
export async function initializeAgentRegistryStore(): Promise<void> {
  if (unsubscribePush) {
    unsubscribePush();
    unsubscribePush = undefined;
  }

  await useAgentRegistryStore.getState().refresh();

  unsubscribePush = ipcOn(IPC_CHANNELS.AGENTS_CHANGED, (event: AgentsChangedEvent) => {
    if (event && Array.isArray(event.agents)) {
      useAgentRegistryStore.getState().setEntries(event.agents);
    }
  });
}

/**
 * 释放订阅（仅供测试 / hot-reload 场景）。
 */
export function disposeAgentRegistryStore(): void {
  if (unsubscribePush) {
    unsubscribePush();
    unsubscribePush = undefined;
  }
}
