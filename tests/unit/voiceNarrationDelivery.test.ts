import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_NARRATION_MAX_RETRY_ATTEMPTS,
  VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS,
  VOICE_NARRATION_RETRY_BASE_MS,
  VOICE_NARRATION_RETRY_MAX_MS,
} from '../../src/shared/constants/voice';
import type { VoiceWorkNarration } from '../../src/shared/contract/voice';
import type { NarrationSession } from '../../src/host/services/voice/voiceNarrationQueue';

const notifyVoiceWorkSettled = vi.hoisted(() => vi.fn());

vi.mock('../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyVoiceWorkSettled },
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/host/telemetry/telemetryService', () => ({
  getTelemetryService: () => ({
    startSpan: () => ({ spanId: 'span-1' }),
    endSpan: vi.fn(),
  }),
}));

const queue = await import('../../src/host/services/voice/voiceNarrationQueue');

function terminalNarration(): VoiceWorkNarration {
  return {
    workItemId: 'voice-work-delivery-1',
    status: 'done',
    title: '季度复盘',
    summary: '报告已经生成。',
  };
}

function fakeSession() {
  const injectItem = vi.fn();
  const session: NarrationSession = {
    id: 'voice-session-1',
    neoSessionId: 'neo-session-1',
    upstream: {
      kind: 'relay',
      provider: 'qwen-omni',
      injectItem,
      isResponding: () => false,
      sendAudio: () => undefined,
      commit: () => undefined,
      respond: () => undefined,
      interrupt: () => null,
      updateInstructions: () => undefined,
      close: async () => undefined,
    },
    narration: queue.createNarrationState(),
  };
  return { session, injectItem };
}

beforeEach(() => {
  vi.useFakeTimers();
  notifyVoiceWorkSettled.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('narration delivery acknowledgement', () => {
  it('注入被拒后按指数退避重试，Renderer 播放确认后停止', async () => {
    const { session, injectItem } = fakeSession();
    const narration = terminalNarration();

    queue.enqueueOrInjectNarration(session, narration);
    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(session.narration.spokenWorkItemIds.has(narration.workItemId)).toBe(false);

    queue.handleNarrationInjectionRejected(session, 'busy');
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_RETRY_BASE_MS - 1);
    expect(injectItem).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(injectItem).toHaveBeenCalledTimes(2);

    queue.handleNarrationInjectionRejected(session, 'busy again');
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_RETRY_BASE_MS * 2);
    expect(injectItem).toHaveBeenCalledTimes(3);

    queue.handleNarrationPlaybackStarted(session, narration.workItemId);
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS * 2);
    expect(injectItem).toHaveBeenCalledTimes(3);
    expect(session.narration.spokenWorkItemIds.has(narration.workItemId)).toBe(true);
    expect(notifyVoiceWorkSettled).not.toHaveBeenCalled();
  });

  it('连续无播放确认耗尽重试后 fail-loud 到系统通知', async () => {
    const { session, injectItem } = fakeSession();
    const narration = terminalNarration();
    queue.enqueueOrInjectNarration(session, narration);

    for (let retry = 0; retry < VOICE_NARRATION_MAX_RETRY_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS);
      const backoff = Math.min(
        VOICE_NARRATION_RETRY_BASE_MS * (2 ** retry),
        VOICE_NARRATION_RETRY_MAX_MS,
      );
      await vi.advanceTimersByTimeAsync(backoff);
    }
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(injectItem).toHaveBeenCalledTimes(VOICE_NARRATION_MAX_RETRY_ATTEMPTS + 1);
    expect(notifyVoiceWorkSettled).toHaveBeenCalledWith({
      sessionId: 'neo-session-1',
      taskTitle: narration.title,
      status: 'done',
      detail: narration.summary,
    });
  });

  it('用户主动打断正在播放的播报视为已送达', async () => {
    const { session, injectItem } = fakeSession();
    const narration = terminalNarration();
    queue.enqueueOrInjectNarration(session, narration);

    queue.handleNarrationPlaybackInterrupted(session);
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS * 2);

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(session.narration.spokenWorkItemIds.has(narration.workItemId)).toBe(true);
  });

  it('挂断时未送达终态走系统通知且不再重试', async () => {
    const { session, injectItem } = fakeSession();
    const narration = terminalNarration();
    queue.enqueueOrInjectNarration(session, narration);

    queue.settleNarrationsForTeardown(session);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS * 2);

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(notifyVoiceWorkSettled).toHaveBeenCalledTimes(1);
  });

  it('退避等待期间挂断也保留终态并转系统通知', async () => {
    const { session, injectItem } = fakeSession();
    const narration = terminalNarration();
    queue.enqueueOrInjectNarration(session, narration);
    queue.handleNarrationInjectionRejected(session, 'busy');

    queue.settleNarrationsForTeardown(session);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_RETRY_BASE_MS * 2);

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(notifyVoiceWorkSettled).toHaveBeenCalledTimes(1);
    expect(notifyVoiceWorkSettled).toHaveBeenCalledWith({
      sessionId: 'neo-session-1',
      taskTitle: narration.title,
      status: 'done',
      detail: narration.summary,
    });
  });

  it('问题已回答后撤销未送达追问，不会被确认超时重新念', async () => {
    const { session, injectItem } = fakeSession();
    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-question:q-1:0:ask',
      status: 'announcement',
      title: '处理方式',
      summary: '请选择处理方式。',
    });

    queue.dismissNarrationsByPrefix(session, 'voice-question:q-1:0:');
    await vi.advanceTimersByTimeAsync(VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS * 2);

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(session.narration.inFlight).toBeNull();
  });

  it('语音问题消费 final transcript 后可显式放行排队的重问', () => {
    const { session, injectItem } = fakeSession();
    queue.markNarrationUserTurn(session);
    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-question:q-1:0:retry',
      status: 'announcement',
      title: '处理方式',
      summary: '请直接说选项名称或编号。',
    });
    expect(injectItem).not.toHaveBeenCalled();

    queue.flushNarrationQueue(session);

    expect(injectItem).toHaveBeenCalledTimes(1);
    expect(session.narration.inFlight?.narration.workItemId).toBe('voice-question:q-1:0:retry');
  });
});
