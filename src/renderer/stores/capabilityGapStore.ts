// ============================================================================
// CapabilityGapStore — Step 7 PR 3
//
// Per-session ephemeral 状态：保存最近一次 `recommend_capability` tool 调用
// 返回的能力缺口快照。InlineWorkbenchBar 读这个 store 渲染 GapCard。
//
// 设计原则：
// - 单次覆盖，不堆栈：每个 session 只保留"最近一次" notice。新 notice 直接覆
//   盖前者；用户 dismiss 后清空。这样 UX 简单可预期。
// - 不持久化：刷新 / 切 session 都丢失。Gap 状态由 main 端 scan 实时计算，
//   没必要在 renderer 侧缓存历史。
// - 不主动订阅 IPC：上层 `useToolExecutionEffects` 在 `tool_call_end` 分支识别
//   `recommend_capability` tool 后调用 `setNotice`。store 自己不感知 IPC。
// ============================================================================

import { create } from 'zustand';
import type { CapabilityGap } from '../../shared/contract/capabilityGap';

export interface CapabilityGapNotice {
  /** 引发本次诊断的 capability 标签（kebab-case） */
  requiredCapability: string;
  /** 诊断出的所有缺口 */
  gaps: CapabilityGap[];
  /** 关联的 tool_call ID，便于追溯 / 调试 */
  toolCallId: string;
}

interface CapabilityGapState {
  /** 每个 session 最多一条 notice。null = 没有 / 已 dismiss */
  noticesBySession: Record<string, CapabilityGapNotice | null>;
}

interface CapabilityGapActions {
  /** 写入或覆盖某 session 的最新 notice */
  setNotice: (sessionId: string, notice: CapabilityGapNotice) => void;
  /** 用户主动关闭，清空该 session 的 notice */
  dismiss: (sessionId: string) => void;
  /** session 删除时清理对应 entry（避免内存泄漏） */
  clearSession: (sessionId: string) => void;
}

type CapabilityGapStore = CapabilityGapState & CapabilityGapActions;

export const useCapabilityGapStore = create<CapabilityGapStore>()((set) => ({
  noticesBySession: {},

  setNotice: (sessionId, notice) =>
    set((state) => ({
      noticesBySession: {
        ...state.noticesBySession,
        [sessionId]: notice,
      },
    })),

  dismiss: (sessionId) =>
    set((state) => {
      if (state.noticesBySession[sessionId] == null) {
        return state;
      }
      return {
        noticesBySession: {
          ...state.noticesBySession,
          [sessionId]: null,
        },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.noticesBySession)) {
        return state;
      }
      const next = { ...state.noticesBySession };
      delete next[sessionId];
      return { noticesBySession: next };
    }),
}));

/**
 * 便捷 selector：读取指定 session 的当前 notice（不存在返回 null）。
 *
 * 用法：`const notice = useCapabilityGapStore(selectNoticeFor(sessionId));`
 */
export const selectNoticeFor =
  (sessionId: string | null | undefined) =>
  (state: CapabilityGapState): CapabilityGapNotice | null => {
    if (!sessionId) return null;
    return state.noticesBySession[sessionId] ?? null;
  };
