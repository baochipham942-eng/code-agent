// ============================================================================
// Appshots Store — 待发送 appshot 的全局状态
// 监听器（useAppshots）写入，composer（ChatInput）读取并在发送时清理。
//
// 飞入落地相位机（motion v2，详设 2026-08-01-appshots-motion-codex-borrow §5.1）：
//   idle → starting（捕获中）→ reserved（图已就绪，chip 占位不可见）
//        → visible（overlay 飞抵落点，handoff 显形）→ enriched（AX/OCR 文本补齐）
// 全程 requestId 校验：handoff / text / image patch 对不上当前 pending 一律丢弃。
// ============================================================================

import { create } from 'zustand';
import type { AppshotCapture, AppshotTextSource } from '@shared/contract/appshot';

export type AppshotPhase = 'idle' | 'starting' | 'reserved' | 'visible' | 'enriched';

interface AppshotsState {
  /** 当前待随下一条消息发送的 appshot（null = 无） */
  pending: AppshotCapture | null;
  /** pending 归属的会话；null 只用于尚未绑定会话的新 composer。 */
  pendingSessionId: string | null;
  /** 热键已触发、捕获进行中（用于轻量 loading 反馈） */
  starting: boolean;
  /** capture_starting 时的会话，用于避免异步抓取完成后串到新会话。 */
  startingSessionId: string | null;
  /** chip 落地相位（飞入 handoff 状态机） */
  phase: AppshotPhase;
  /** handoff 先于 image_ready 处理时暂存，setImageReady 时补应用（reduced-motion / 跳过飞入时 Rust 立刻 emit） */
  handoffRequestId: string | null;
  /**
   * 发送目标会话设置（'current' | 'new'）的本地缓存：
   * 设置 IPC 延迟可达秒级，捕获链路（skip 决策 / pending 绑定）必须同步可读，
   * 由 useAppshots 启动时刷新、AppshotsSettings 变更时写入。
   */
  targetSession: 'current' | 'new';
  setTargetSession: (target: 'current' | 'new') => void;
  /**
   * 兼容别名：一次性写入「全量就绪」的 capture 并直接可见（草稿恢复等无飞入场景）。
   * 飞入链路请用 setImageReady（reserved，等 handoff 显形）。
   */
  setPending: (capture: AppshotCapture | null, sessionId: string | null) => void;
  /** image_ready：写入 pending，chip 进入 reserved 占位（已暂存 handoff 则直接 visible） */
  setImageReady: (capture: AppshotCapture, sessionId: string | null) => void;
  /** overlay 飞抵落点：reserved → visible（错 requestId 丢弃；pending 未写入则暂存） */
  markHandoff: (requestId: string) => void;
  /** text_ready：同 requestId 补齐 AX/OCR 文本（visible 后到达则进 enriched，不 remount） */
  patchText: (requestId: string, axText: string | null, textSource: AppshotTextSource) => void;
  /** image_ready 后并行读出的截图 dataURL，到了就 patch 进 chip */
  patchImage: (requestId: string, screenshotDataUrl: string) => void;
  setStarting: (value: boolean, sessionId: string | null) => void;
  clear: () => void;
}

export const useAppshotsStore = create<AppshotsState>((set) => ({
  pending: null,
  pendingSessionId: null,
  starting: false,
  startingSessionId: null,
  phase: 'idle',
  handoffRequestId: null,
  targetSession: 'current',
  setTargetSession: (target) => set({ targetSession: target }),
  setPending: (capture, sessionId) => set({
    pending: capture,
    pendingSessionId: capture ? sessionId : null,
    starting: false,
    startingSessionId: null,
    phase: capture ? 'visible' : 'idle',
    handoffRequestId: null,
  }),
  setImageReady: (capture, sessionId) => set((state) => ({
    pending: capture,
    pendingSessionId: sessionId,
    starting: false,
    startingSessionId: null,
    phase: state.handoffRequestId === capture.requestId ? 'visible' : 'reserved',
    handoffRequestId: null,
  })),
  markHandoff: (requestId) => set((state) => {
    if (state.pending?.requestId === requestId) {
      return {
        phase: state.phase === 'reserved' ? 'visible' : state.phase,
        handoffRequestId: null,
      };
    }
    // pending 尚未写入（image_ready 事件还在处理）：暂存，setImageReady 时补应用
    return { handoffRequestId: requestId };
  }),
  patchText: (requestId, axText, textSource) => set((state) => {
    if (state.pending?.requestId !== requestId) return state;
    return {
      pending: { ...state.pending, axText, textSource, textReady: true },
      phase: state.phase === 'visible' ? 'enriched' : state.phase,
    };
  }),
  patchImage: (requestId, screenshotDataUrl) => set((state) => {
    if (state.pending?.requestId !== requestId) return state;
    return { pending: { ...state.pending, screenshotDataUrl } };
  }),
  setStarting: (value, sessionId) => set((state) => ({
    starting: value,
    startingSessionId: value ? sessionId : null,
    phase: value ? 'starting' : (state.pending ? state.phase : 'idle'),
    handoffRequestId: value ? null : state.handoffRequestId,
  })),
  clear: () => set({
    pending: null,
    pendingSessionId: null,
    starting: false,
    startingSessionId: null,
    phase: 'idle',
    handoffRequestId: null,
  }),
}));
