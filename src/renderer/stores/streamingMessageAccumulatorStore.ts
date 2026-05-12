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
  appendDelta: (messageId: string, delta: { content?: string; reasoning?: string }) => void;
  consumeDelta: (messageId: string) => StreamingMessageDelta | null;
  consumeAll: () => Record<string, StreamingMessageDelta>;
  clear: (messageId: string) => void;
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
  },

  consumeDelta: (messageId) => {
    const entry = get().entries[messageId];
    if (!entry) return null;

    set((state) => {
      const nextEntries = { ...state.entries };
      delete nextEntries[messageId];
      recordAccumulatorGauges(nextEntries);
      return { entries: nextEntries };
    });

    return entry;
  },

  consumeAll: () => {
    const entries = get().entries;
    if (Object.keys(entries).length === 0) return {};
    recordAccumulatorGauges({});
    set({ entries: {} });
    return entries;
  },

  clear: (messageId) => {
    if (!get().entries[messageId]) return;
    recordStreamingPerformanceCounter('stream.accumulator.clear');
    set((state) => {
      const nextEntries = { ...state.entries };
      delete nextEntries[messageId];
      recordAccumulatorGauges(nextEntries);
      return { entries: nextEntries };
    });
  },
}));
