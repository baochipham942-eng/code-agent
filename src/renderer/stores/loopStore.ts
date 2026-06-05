// ============================================================================
// loopStore — 会话内循环（/loop）的前端状态。
// Slice 1：靠轮询 loop:list 同步状态（每轮 agent 回复本身走 session 流式显示，
// 这里只负责「循环运行中 / 第 N 轮 / 停止」的控制条状态）。
// ============================================================================

import { create } from 'zustand';
import type { LoopRunState } from '@shared/contract/loop';
import { loopClient } from '../services/loopClient';

interface LoopStore {
  loops: Record<string, LoopRunState>;
  track: (state: LoopRunState) => void;
  refresh: (sessionId?: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
}

export const useLoopStore = create<LoopStore>((set, get) => ({
  loops: {},

  track: (state) => set((s) => ({ loops: { ...s.loops, [state.id]: state } })),

  refresh: async (sessionId) => {
    try {
      const list = await loopClient.list(sessionId);
      set((s) => {
        const next = { ...s.loops };
        for (const l of list) next[l.id] = l;
        return { loops: next };
      });
    } catch {
      // 轮询失败不打扰用户
    }
  },

  stop: async (id) => {
    try {
      const state = await loopClient.stop(id);
      if (state) get().track(state);
    } catch {
      // 忽略，下次轮询会纠正状态
    }
  },
}));
