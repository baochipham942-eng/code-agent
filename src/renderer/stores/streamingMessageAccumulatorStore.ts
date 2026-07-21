import { create } from 'zustand';
import {
  recordStreamingPerformanceCounter,
  setStreamingPerformanceGauge,
} from '../utils/streamingPerformanceMetrics';

export interface StreamingMessageDelta {
  contentDelta: string;
  reasoningDelta: string;
  updatedAt: number;
}

interface StreamingMessageAccumulatorState {
  entries: Record<string, StreamingMessageDelta>;
  /**
   * 供视觉层（投影 overlay）订阅的节流快照：entries 每个 token 都在变，直接订阅会让
   * 转录投影按 token 频率全量重算（2026-07-21 真机视频闪烁的放大器之一）。快照按
   * STREAMING_VISIBLE_PUBLISH_INTERVAL_MS 发布（首帧立即、其余合并），flush/clear 时
   * 同步对齐，保证消费掉的 delta 不会在快照里残留造成重复渲染。
   */
  visibleEntries: Record<string, StreamingMessageDelta>;
  appendDelta: (messageId: string, delta: { content?: string; reasoning?: string }) => void;
  consumeDelta: (messageId: string) => StreamingMessageDelta | null;
  consumeAll: () => Record<string, StreamingMessageDelta>;
  clear: (messageId: string) => void;
}

export const STREAMING_VISIBLE_PUBLISH_INTERVAL_MS = 150;

let visiblePublishTimer: ReturnType<typeof setTimeout> | null = null;
let lastVisiblePublishAt = 0;

function cancelVisiblePublishTimer(): void {
  if (visiblePublishTimer) {
    clearTimeout(visiblePublishTimer);
    visiblePublishTimer = null;
  }
}

function hasDelta(delta: { content?: string; reasoning?: string }): boolean {
  return Boolean(delta.content || delta.reasoning);
}

function getEntryCharCount(entry: StreamingMessageDelta): number {
  return entry.contentDelta.length + entry.reasoningDelta.length;
}

function recordAccumulatorGauges(entries: Record<string, StreamingMessageDelta>): void {
  setStreamingPerformanceGauge('stream.accumulator.active_entries', Object.keys(entries).length);
  setStreamingPerformanceGauge(
    'stream.accumulator.active_chars',
    Object.values(entries).reduce((total, entry) => total + getEntryCharCount(entry), 0),
  );
}

export const useStreamingMessageAccumulatorStore = create<StreamingMessageAccumulatorState>()((set, get) => ({
  entries: {},
  visibleEntries: {},

  appendDelta: (messageId, delta) => {
    if (!messageId || !hasDelta(delta)) return;
    recordStreamingPerformanceCounter('stream.accumulator.append');
    recordStreamingPerformanceCounter(
      'stream.accumulator.append_chars',
      (delta.content?.length || 0) + (delta.reasoning?.length || 0),
    );

    set((state) => {
      const existing = state.entries[messageId];
      const entries = {
        ...state.entries,
        [messageId]: {
          contentDelta: (existing?.contentDelta || '') + (delta.content || ''),
          reasoningDelta: (existing?.reasoningDelta || '') + (delta.reasoning || ''),
          updatedAt: Date.now(),
        },
      };
      recordAccumulatorGauges(entries);
      return {
        entries,
      };
    });

    // leading+trailing 节流发布可见快照
    const now = Date.now();
    const elapsed = now - lastVisiblePublishAt;
    if (elapsed >= STREAMING_VISIBLE_PUBLISH_INTERVAL_MS) {
      lastVisiblePublishAt = now;
      set({ visibleEntries: get().entries });
    } else if (!visiblePublishTimer) {
      visiblePublishTimer = setTimeout(() => {
        visiblePublishTimer = null;
        lastVisiblePublishAt = Date.now();
        set({ visibleEntries: get().entries });
      }, STREAMING_VISIBLE_PUBLISH_INTERVAL_MS - elapsed);
    }
  },

  consumeDelta: (messageId) => {
    const entry = get().entries[messageId];
    if (!entry) return null;

    set((state) => {
      const nextEntries = { ...state.entries };
      delete nextEntries[messageId];
      recordAccumulatorGauges(nextEntries);
      return { entries: nextEntries, visibleEntries: nextEntries };
    });
    cancelVisiblePublishTimer();

    return entry;
  },

  consumeAll: () => {
    const entries = get().entries;
    if (Object.keys(entries).length === 0) return {};
    recordAccumulatorGauges({});
    set({ entries: {}, visibleEntries: {} });
    cancelVisiblePublishTimer();
    return entries;
  },

  clear: (messageId) => {
    if (!get().entries[messageId]) return;
    recordStreamingPerformanceCounter('stream.accumulator.clear');
    set((state) => {
      const nextEntries = { ...state.entries };
      delete nextEntries[messageId];
      recordAccumulatorGauges(nextEntries);
      return { entries: nextEntries, visibleEntries: nextEntries };
    });
    cancelVisiblePublishTimer();
  },
}));
