// 钉住 web 模式两条投递链共用一套 epoch/seq：
// TaskManager 信封（/api/events）与 /api/run batcher（直连流）交替进入真实 dispatcher。
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import { ipcService } from '../../src/renderer/services/ipcService';
import { envelopeRendererAgentEvent } from '../../src/host/protocol/rendererAgentStreamCursor';
import {
  envelopeWebAgentEvent,
  resetWebAgentEventSequencesForTests,
} from '../../src/web/helpers/agentStreamCursor';
import { createAgentRunSSEBatcher } from '../../src/web/helpers/agentRunSSEBatcher';

type StreamEvent = {
  type: string;
  streamEpoch: string;
  sessionId: string;
  seq: number;
  data?: unknown;
};

type SnapshotSignal = {
  reason?: string;
  streamEpoch?: string;
  sessionId?: string;
  watermark?: number;
  transport?: string;
};

function turnIdOf(event: StreamEvent): string | undefined {
  const data = event.data;
  if (!data || typeof data !== 'object' || !('turnId' in data)) return undefined;
  return typeof data.turnId === 'string' ? data.turnId : undefined;
}

function cursorFromRunPayload(data: unknown): {
  streamEpoch: string;
  sessionId: string;
  seq: number;
} {
  if (!data || typeof data !== 'object') {
    throw new Error('run payload must be an object');
  }
  const payload = data as { streamEpoch?: unknown; sessionId?: unknown; seq?: unknown };
  if (
    typeof payload.streamEpoch !== 'string'
    || typeof payload.sessionId !== 'string'
    || typeof payload.seq !== 'number'
  ) {
    throw new Error('run payload missing stream cursor');
  }
  return {
    streamEpoch: payload.streamEpoch,
    sessionId: payload.sessionId,
    seq: payload.seq,
  };
}

function installDispatcher(): {
  emit: (event: StreamEvent) => void;
  dispatched: StreamEvent[];
  signals: SnapshotSignal[];
} {
  const listeners: Array<(event: StreamEvent) => void> = [];
  (globalThis as { window?: unknown }).window = {
    codeAgentAPI: {
      invoke: () => undefined,
      on: (channel: string, callback: (event: StreamEvent) => void) => {
        if (channel === IPC_CHANNELS.AGENT_EVENT) listeners.push(callback);
        return () => {};
      },
      off: () => {},
    },
  };
  const dispatched: StreamEvent[] = [];
  const signals: SnapshotSignal[] = [];
  ipcService.on(IPC_CHANNELS.AGENT_STREAM_SNAPSHOT_REQUIRED, (signal) => {
    signals.push(signal);
  });
  ipcService.on(IPC_CHANNELS.AGENT_EVENT, (event) => {
    dispatched.push(event);
  });
  return {
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    dispatched,
    signals,
  };
}

describe('web mode shared agent stream cursor', () => {
  afterEach(() => {
    resetWebAgentEventSequencesForTests();
  });

  it('delivers 100 interleaved producer events once, with no false snapshot', () => {
    const { emit, dispatched, signals } = installDispatcher();
    const sessionId = 'session-live';
    const batcher = createAgentRunSSEBatcher((eventType, data) => {
      const cursor = cursorFromRunPayload(data);
      emit({
        type: eventType,
        data,
        streamEpoch: cursor.streamEpoch,
        sessionId: cursor.sessionId,
        seq: cursor.seq,
      });
    }, sessionId);

    for (let i = 0; i < 100; i += 1) {
      const event = {
        type: 'turn_start' as const,
        data: { turnId: `turn-${i}`, iteration: 1 },
      };
      if (i % 2 === 0) {
        emit(envelopeRendererAgentEvent(sessionId, event));
      } else {
        batcher.emit(event);
      }
    }
    batcher.flush();

    expect(signals.filter((signal) => signal.reason === 'epoch_changed')).toEqual([]);
    expect(signals.filter((signal) => signal.reason === 'sequence_gap')).toEqual([]);
    expect(dispatched).toHaveLength(100);
    expect(dispatched.map((event) => event.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(new Set(dispatched.map((event) => event.streamEpoch)).size).toBe(1);
    expect(dispatched[0]?.streamEpoch).toMatch(/^http:/);
    expect(new Set(dispatched.map((event) => turnIdOf(event))).size).toBe(100);
  });

  it('still requests a snapshot when a produced event is dropped', () => {
    const { emit, dispatched, signals } = installDispatcher();
    const sessionId = 'session-gap';
    const first = envelopeWebAgentEvent(sessionId, {
      type: 'turn_start',
      data: { turnId: 'kept-0', iteration: 1 },
    });
    const dropped = envelopeWebAgentEvent(sessionId, {
      type: 'turn_start',
      data: { turnId: 'dropped-1', iteration: 1 },
    });
    const third = envelopeWebAgentEvent(sessionId, {
      type: 'turn_start',
      data: { turnId: 'kept-2', iteration: 1 },
    });
    emit(first);
    void dropped;
    emit(third);

    expect(signals.map((signal) => signal.reason)).toEqual(['sequence_gap']);
    expect(signals[0]).toMatchObject({
      reason: 'sequence_gap',
      sessionId,
      watermark: 3,
    });
    expect(dispatched.map((event) => event.seq)).toEqual([1, 3]);
    expect(dispatched.map((event) => turnIdOf(event))).toEqual(['kept-0', 'kept-2']);
  });

  it('still requests a snapshot when the host epoch restarts', () => {
    const { emit, dispatched, signals } = installDispatcher();
    const sessionId = 'session-restart';
    emit(envelopeWebAgentEvent(sessionId, {
      type: 'turn_start',
      data: { turnId: 'before-restart', iteration: 1 },
    }));
    emit({
      type: 'turn_start',
      data: { turnId: 'after-restart', iteration: 1 },
      streamEpoch: 'http:restarted-process',
      sessionId,
      seq: 1,
    });

    expect(signals.map((signal) => signal.reason)).toEqual(['epoch_changed']);
    expect(signals[0]).toMatchObject({
      reason: 'epoch_changed',
      streamEpoch: 'http:restarted-process',
      sessionId,
      watermark: 1,
      transport: 'http-sse',
    });
    expect(dispatched).toHaveLength(2);
  });
});
