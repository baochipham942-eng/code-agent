import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import {
  STREAMING_VISIBLE_PUBLISH_INTERVAL_MS,
  useStreamingMessageAccumulatorStore,
} from '../../../src/renderer/stores/streamingMessageAccumulatorStore';
import { applyStreamingMessageDeltasToProjection } from '../../../src/renderer/utils/streamingProjectionOverlay';

function projectionWithMessages(...messageIds: string[]): TraceProjection {
  return {
    sessionId: 'order-invariant-session',
    activeTurnIndex: messageIds.length - 1,
    turns: messageIds.map((messageId, index) => ({
      turnNumber: index + 1,
      turnId: `turn-${messageId}`,
      status: 'streaming',
      startTime: 100 + index,
      nodes: [{
        id: `${messageId}-text`,
        messageId,
        type: 'assistant_text',
        content: '',
        timestamp: 100 + index,
      }],
    })),
  };
}

describe('streaming accumulator/overlay render order invariants', () => {
  let clockMs = 2_000_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    clockMs += STREAMING_VISIBLE_PUBLISH_INTERVAL_MS * 10;
    vi.setSystemTime(clockMs);
    useStreamingMessageAccumulatorStore.getState().consumeAll();
  });

  afterEach(() => {
    useStreamingMessageAccumulatorStore.getState().consumeAll();
    vi.useRealTimers();
  });

  it('renders content and reasoning deltas in appendDelta call order', () => {
    const store = useStreamingMessageAccumulatorStore.getState();
    store.appendDelta('assistant-1', { content: 'A', reasoning: '1' });
    store.appendDelta('assistant-1', { content: 'B', reasoning: '2' });
    store.appendDelta('assistant-1', { content: 'C', reasoning: '3' });
    vi.advanceTimersByTime(STREAMING_VISIBLE_PUBLISH_INTERVAL_MS);

    const rendered = applyStreamingMessageDeltasToProjection(
      projectionWithMessages('assistant-1'),
      [],
      useStreamingMessageAccumulatorStore.getState().visibleEntries,
    );

    expect(rendered.turns[0].nodes[0]).toMatchObject({
      content: 'ABC',
      reasoning: '123',
    });
  });

  it('aligns visibleEntries after consumeDelta without rendering consumed bytes twice', () => {
    const store = useStreamingMessageAccumulatorStore.getState();
    store.appendDelta('assistant-1', { content: 'first' });
    store.appendDelta('assistant-1', { content: '-second' });

    const consumed = store.consumeDelta('assistant-1');
    expect(consumed?.contentDelta).toBe('first-second');

    const persistedProjection = projectionWithMessages('assistant-1');
    persistedProjection.turns[0].nodes[0].content = consumed?.contentDelta ?? '';
    const rendered = applyStreamingMessageDeltasToProjection(
      persistedProjection,
      [],
      useStreamingMessageAccumulatorStore.getState().visibleEntries,
    );

    expect(useStreamingMessageAccumulatorStore.getState().entries).toEqual({});
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries).toEqual({});
    expect(rendered.turns[0].nodes[0].content).toBe('first-second');

    vi.advanceTimersByTime(STREAMING_VISIBLE_PUBLISH_INTERVAL_MS * 2);
    expect(useStreamingMessageAccumulatorStore.getState().visibleEntries).toEqual({});
  });

  it('keeps interleaved messages in independent per-message order', () => {
    const store = useStreamingMessageAccumulatorStore.getState();
    store.appendDelta('assistant-1', { content: 'A' });
    store.appendDelta('assistant-2', { content: '1' });
    store.appendDelta('assistant-1', { content: 'B' });
    store.appendDelta('assistant-2', { content: '2' });
    store.appendDelta('assistant-1', { content: 'C' });
    store.appendDelta('assistant-2', { content: '3' });
    vi.advanceTimersByTime(STREAMING_VISIBLE_PUBLISH_INTERVAL_MS);

    const rendered = applyStreamingMessageDeltasToProjection(
      projectionWithMessages('assistant-1', 'assistant-2'),
      [],
      useStreamingMessageAccumulatorStore.getState().visibleEntries,
    );

    expect(rendered.turns[0].nodes[0].content).toBe('ABC');
    expect(rendered.turns[1].nodes[0].content).toBe('123');
  });
});
