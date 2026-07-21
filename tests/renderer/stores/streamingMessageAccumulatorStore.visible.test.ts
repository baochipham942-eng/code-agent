// ============================================================================
// visibleEntries 节流快照 — 投影 overlay 不再按 token 频率重算（2026-07-21 闪烁修复）
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useStreamingMessageAccumulatorStore,
  STREAMING_VISIBLE_PUBLISH_INTERVAL_MS,
} from '../../../src/renderer/stores/streamingMessageAccumulatorStore';

describe('streamingMessageAccumulatorStore visibleEntries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStreamingMessageAccumulatorStore.getState().consumeAll();
    // 消耗 leading 窗口，让下一次 append 处于「距上次发布很久」的状态
    vi.advanceTimersByTime(STREAMING_VISIBLE_PUBLISH_INTERVAL_MS * 2);
  });

  afterEach(() => {
    useStreamingMessageAccumulatorStore.getState().consumeAll();
    vi.useRealTimers();
  });

  it('首个 delta 立即发布（leading），窗口内后续 delta 合并到 trailing 发布', () => {
    const store = useStreamingMessageAccumulatorStore.getState();
    store.appendDelta('m1', { reasoning: 'a' });
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries.m1?.reasoningDelta).toBe('a');

    store.appendDelta('m1', { reasoning: 'b' });
    store.appendDelta('m1', { reasoning: 'c' });
    // 窗口未到：快照不动，entries 已积累
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries.m1?.reasoningDelta).toBe('a');
    expect(useStreamingMessageAccumulatorStore.getState().entries.m1?.reasoningDelta).toBe('abc');

    vi.advanceTimersByTime(STREAMING_VISIBLE_PUBLISH_INTERVAL_MS);
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries.m1?.reasoningDelta).toBe('abc');
  });

  it('clear/consume 同步清掉快照，已落账 delta 不会残留造成重复渲染', () => {
    const store = useStreamingMessageAccumulatorStore.getState();
    store.appendDelta('m1', { reasoning: 'a' });
    store.appendDelta('m1', { reasoning: 'b' });
    store.clear('m1');
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries.m1).toBeUndefined();

    // 之前排的 trailing 定时器不应把已清掉的内容再发布出来
    vi.advanceTimersByTime(STREAMING_VISIBLE_PUBLISH_INTERVAL_MS * 2);
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries.m1).toBeUndefined();
  });

  it('consumeAll 清空快照', () => {
    const store = useStreamingMessageAccumulatorStore.getState();
    store.appendDelta('m1', { content: 'x' });
    store.consumeAll();
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries).toEqual({});
  });
});
