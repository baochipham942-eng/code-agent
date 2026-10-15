// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@shared/contract';
import type { LoopRunState } from '../../../src/shared/contract/loop';
import {
  isLoopCommand,
  parseLoopCommand,
} from '../../../src/renderer/components/features/chat/ChatInput/parseLoopCommand';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/services/loopClient', () => ({
  loopClient: { start: mocks.start },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const loopState: LoopRunState = {
  id: 'loop-1',
  sessionId: 'session-1',
  prompt: '巡检',
  intervalMs: 30_000,
  maxTurns: 5,
  turn: 0,
  status: 'running',
  startedAt: 1,
  nextRunAt: 31_000,
  phase: 'sleeping',
};

describe('/loop command helpers', () => {
  it('detects only the loop slash command', () => {
    expect(isLoopCommand('/loop 查部署状态')).toBe(true);
    expect(isLoopCommand('  /loop 查部署状态')).toBe(true);
    expect(isLoopCommand('/loophole')).toBe(false);
    expect(isLoopCommand('/lo 查')).toBe(false);
  });

  it('parses a fixed-interval loop with prompt', () => {
    expect(parseLoopCommand('/loop 30s 查部署状态，好了告诉我')).toEqual({
      prompt: '查部署状态，好了告诉我',
      intervalMs: 30_000,
    });
  });

  it('parses minutes and hours units', () => {
    expect(parseLoopCommand('/loop 5m 巡检')).toMatchObject({ intervalMs: 300_000 });
    expect(parseLoopCommand('/loop 2h 巡检')).toMatchObject({ intervalMs: 7_200_000 });
  });

  it('parses a composite duration', () => {
    expect(parseLoopCommand('/loop 1h30m 巡检')).toMatchObject({ intervalMs: 5_400_000 });
  });

  it('treats a bare prompt without leading duration as self-paced (no interval)', () => {
    expect(parseLoopCommand('/loop 改到测试全绿')).toEqual({ prompt: '改到测试全绿' });
  });

  it('does not treat a unitless number as an interval', () => {
    expect(parseLoopCommand('/loop 5 个测试要跑')).toEqual({ prompt: '5 个测试要跑' });
  });

  it('parses flags: max-turns / until / budget', () => {
    expect(
      parseLoopCommand('/loop 1m 巡检 CI --max-turns 8 --until "全部通过" --budget 50000'),
    ).toEqual({
      prompt: '巡检 CI',
      intervalMs: 60_000,
      maxTurns: 8,
      until: '全部通过',
      budget: 50_000,
    });
  });

  it('keeps an empty prompt empty so the submit layer can show usage', () => {
    expect(parseLoopCommand('/loop 30s')).toEqual({ prompt: '', intervalMs: 30_000 });
  });

  it('returns null for non-loop input', () => {
    expect(parseLoopCommand('/goal 修好链路')).toBeNull();
  });

  it('parses --ephemeral as a boolean flag and keeps the prompt', () => {
    expect(parseLoopCommand('/loop --ephemeral 查部署状态')).toEqual({
      prompt: '查部署状态',
      ephemeral: true,
    });
    expect(parseLoopCommand('/loop 30s 巡检 --ephemeral --max-turns 3')).toEqual({
      prompt: '巡检',
      intervalMs: 30_000,
      maxTurns: 3,
      ephemeral: true,
    });
  });
});

function makeLoopParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-1',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    agentEntries: [],
    buildEnvelope: vi.fn((content: string) => ({ content })) as never,
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: { current: { focus: vi.fn() } } as never,
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    openSeedComposer: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

describe('/loop submit created notice (FB-327 dedupe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue(loopState);
  });

  it('one loopClient.start leaves exactly one created notice: the host broadcast copy', async () => {
    // 真实链路：host loopController.start() 无条件调 recordAutomationCreated（durable
    // 与 --ephemeral 都发）落库并广播 created 通知；App.tsx 监听器按 id 去重后
    // addMessage。渲染端 /loop 分支不再乐观插入同 id 的第二条。
    useSessionStore.setState({ messages: [], currentSessionId: 'session-1' });
    // host sessionAutomationService.writeAutomationMessage 的消息形状：
    // id = `automation:created:loop:${loopId}`。
    const hostBroadcast: Message = {
      id: 'automation:created:loop:loop-1',
      role: 'assistant',
      source: 'automation',
      content: '自动化已创建：循环 · 巡检\n频率：每 30 秒\n状态：运行中',
      timestamp: 1_700_000_000_000,
      isMeta: true,
      metadata: {
        automation: {
          automationId: 'loop:loop-1',
          automationType: 'loop',
          event: 'created',
          sourceSessionId: 'session-1',
          sourceRefId: 'loop-1',
          status: 'running',
          title: '循环 · 巡检',
          cadenceLabel: '每 30 秒',
          nextRunAt: 31_000,
        },
      },
    };
    mocks.start.mockImplementationOnce(async () => {
      // 广播在 loopClient.start 的 promise resolve 之前落地——照 App.tsx 监听器的写法投递。
      const store = useSessionStore.getState();
      if (!store.messages.some((m) => m.id === hostBroadcast.id)) {
        store.addMessage(hostBroadcast);
      }
      return loopState;
    });

    const { result } = renderHook(() => useChatInputSubmit(makeLoopParams({ value: '/loop 30s 巡检' })));
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as never);
    });

    const createdNotices = useSessionStore.getState().messages.filter(
      (m) => m.metadata?.automation?.event === 'created' && m.metadata?.automation?.automationId === 'loop:loop-1',
    );
    expect(createdNotices).toHaveLength(1);
    expect(createdNotices[0]?.id).toBe('automation:created:loop:loop-1');
    // 留下的必须是 host 那条（带下次运行），不是缺 nextRunAt 的乐观副本。
    expect(createdNotices[0]?.metadata?.automation?.nextRunAt).toBe(31_000);
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });
});
