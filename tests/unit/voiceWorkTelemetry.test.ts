// ============================================================================
// R5 workItem 三元组升 telemetry
//
// #903 把 workItemId 三元组落进了日志，日志能查单次事故，答不了「进度闸吞掉了多少条、
// 吞在哪一格」。这一组钉三件事：
//   1. 派活 / 口播 / 丢弃三类事件都带同一个 workItemId，链路能对上；
//   2. 维度取**真实** workItemId，不取 `<id>:milestone-3` 这种每条都不同的合成键
//      （按它分组等于没分组）；
//   3. **一个字用户内容都不许进遥测**。这条是最容易在加维度时被顺手破坏的，
//      所以断言方式是「把活儿名和台词原文拿去搜遍所有属性值」，而不是逐个字段点名——
//      逐个点名的话，新加一个泄漏字段照样全绿。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/shared/contract/agent';
import type { AgentRunOptions } from '../../src/host/research/types';
import type { SessionTask } from '../../src/shared/contract/planning';
import type { VoiceWorkNarration } from '../../src/shared/contract/voice';
import type { NarrationSession } from '../../src/host/services/voice/voiceNarrationQueue';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  observers: new Set<(sessionId: string, event: AgentEvent) => void>(),
  status: 'idle' as string,
  incompleteTasks: [] as Array<{ subject: string; status: string }>,
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  cancelTask: vi.fn(async (_sessionId: string) => undefined),
  interruptAndContinue: vi.fn(async (
    _sessionId: string,
    _instruction: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
  emitAgent(event: AgentEvent, sessionId = 'session-1') {
    for (const observer of [...this.observers]) observer(sessionId, event);
  },
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    observeAgentEvents: (observer: (sessionId: string, event: AgentEvent) => void) => {
      runtime.observers.add(observer);
      return () => { runtime.observers.delete(observer); };
    },
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: runtime.interruptAndContinue,
    cancelTask: runtime.cancelTask,
  }),
}));
vi.mock('../../src/host/session/completionSummaryService', () => ({
  readLatestCompletionSummaryRecord: vi.fn(async () => null),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => '<role/>'),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => runtime.incompleteTasks,
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ messages: [{ role: 'assistant', content: '做完了。' }] }),
    addMessageToSession: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyVoiceWorkSettled: vi.fn() },
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    markLiveVoiceSession: vi.fn(),
    clearLiveVoiceSession: vi.fn(),
    isLiveVoiceSession: () => true,
    getModeForSession: () => 'readOnly',
  }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: () => undefined }),
}));

const { beginVoiceDispatch, endVoiceDispatch, dispatchVoiceIntent } =
  await import('../../src/host/services/voice/voiceAgentCoordinator');

const narrations: VoiceWorkNarration[] = [];

function begin(): void {
  narrations.length = 0;
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: () => {},
    onEndCall: () => {},
    onWorkNarration: (narration) => { narrations.push(narration) },
    onWorkFailed: () => {},
  });
}


/** 捕获所有 span 属性；遥测断言全部对着这份记录做。 */
const spans = vi.hoisted(() => [] as Array<{ name: string; attributes: Record<string, unknown> }>);
vi.mock('../../src/host/telemetry/telemetryService', () => ({
  getTelemetryService: () => ({
    startSpan: (name: string, _kind: string, attributes: Record<string, unknown>) => {
      spans.push({ name, attributes });
      return { spanId: `span-${spans.length}` };
    },
    endSpan: () => undefined,
  }),
}));

const queue = await import('../../src/host/services/voice/voiceNarrationQueue');

/** 最小 relay 上游：队列只用到 injectItem / isResponding / kind。 */
function fakeSession(): NarrationSession {
  return {
    id: 'voice-1',
    neoSessionId: 'session-1',
    upstream: {
      kind: 'relay',
      provider: 'qwen-omni',
      injectItem: () => undefined,
      isResponding: () => false,
      sendAudio: () => undefined,
      commit: () => undefined,
      respond: () => undefined,
      interrupt: () => null,
      updateInstructions: () => undefined,
      close: async () => undefined,
    } as never,
    narration: queue.createNarrationState(),
  };
}

const voiceSpans = () => spans.filter((s) => s.name === 'voice_work');
const phases = () => voiceSpans().map((s) => s.attributes['voice_work.phase']);

/** 把所有属性值摊平成一串，用来搜有没有夹带用户内容。 */
const allValues = () => voiceSpans().flatMap((s) => Object.values(s.attributes)).map(String).join(' | ');

beforeEach(() => {
  vi.useFakeTimers();
  spans.length = 0;
  runtime.listeners.clear();
  runtime.observers.clear();
  runtime.incompleteTasks = [];
  runtime.status = 'idle';
  runtime.startTask.mockClear();
  begin();
});

afterEach(() => {
  endVoiceDispatch();
  vi.useRealTimers();
});

describe('派活落一条 dispatch 事件', () => {
  it('带真实 workItemId，且不带活儿名', async () => {
    await dispatchVoiceIntent({ kind: 'spawn_task', title: '写季度复盘', prompt: '写一份季度复盘' });

    const dispatched = voiceSpans().filter((s) => s.attributes['voice_work.phase'] === 'dispatch');
    expect(dispatched).toHaveLength(1);
    expect(String(dispatched[0]?.attributes['voice_work.work_item_id'])).toMatch(/^voice-work-/);
    expect(allValues()).not.toContain('写季度复盘');
  });
});

describe('口播与丢弃各落一条，workItemId 与派活对得上', () => {
  it('播出去的记 narration_spoken，维度是真实 id 不是合成键', () => {
    const session = fakeSession();
    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-work-42:milestone-3',
      status: 'milestone',
      title: '写季度复盘',
      summary: '大纲列完了',
    });

    expect(phases()).toEqual(['narration_spoken']);
    // 合成键每条都不一样，按它分组等于没分组。
    expect(voiceSpans()[0]?.attributes['voice_work.work_item_id']).toBe('voice-work-42');
  });

  it('被闸掉的记 narration_dropped，且写明是哪一格闸', () => {
    const session = fakeSession();
    session.narration.firstDispatchAt = Date.now();

    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-work-42:milestone-1',
      status: 'milestone',
      title: '写季度复盘',
      summary: '大纲列完了',
    });

    expect(phases()).toEqual(['narration_dropped']);
    expect(voiceSpans()[0]?.attributes['voice_work.drop_reason']).toBe('first_delay_window');
    expect(voiceSpans()[0]?.attributes['voice_work.work_item_id']).toBe('voice-work-42');
  });

  it('worth-hearing 与否是一个维度，两类都记得出来', () => {
    const session = fakeSession();
    session.narration.firstDispatchAt = Date.now();

    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-work-42:blocked-1',
      status: 'milestone',
      worthHearing: true,
      title: '写季度复盘',
      summary: '卡在登录上了',
    });
    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-work-42:milestone-1',
      status: 'milestone',
      title: '写季度复盘',
      summary: '大纲列完了',
    });

    expect(phases()).toEqual(['narration_spoken', 'narration_dropped']);
    expect(voiceSpans()[0]?.attributes['voice_work.worth_hearing']).toBe(true);
    expect(voiceSpans()[1]?.attributes['voice_work.worth_hearing']).toBe(false);
  });
});

describe('隐私边界：一个字用户内容都不进遥测', () => {
  it('活儿名、台词、结论摘要都搜不到', () => {
    const session = fakeSession();

    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-work-42',
      status: 'done',
      title: '把季度复盘发给张总',
      summary: '已经发到 zhang@example.com 了，附件在 /Users/me/Documents/q3.pdf',
    });
    session.narration.userSpeaking = true;
    queue.enqueueOrInjectNarration(session, {
      workItemId: 'voice-work-43:milestone-1',
      status: 'milestone',
      title: '订去上海的机票',
      summary: '查到三班航班',
    });
    queue.markNarrationUserTurn(session);

    // 正对照：确实产了事件（不然「什么都没产」也会让下面全绿）。
    expect(voiceSpans().length).toBeGreaterThan(0);

    const values = allValues();
    for (const leak of ['季度复盘', '张总', 'zhang@example.com', 'q3.pdf', '上海', '三班航班']) {
      expect(values).not.toContain(leak);
    }
  });
});
