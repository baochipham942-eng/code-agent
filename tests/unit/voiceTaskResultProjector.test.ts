import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/shared/contract/message';
import type { VoiceWorkItem } from '../../src/shared/contract/voice';

const sessionManager = vi.hoisted(() => ({
  addMessageToSession: vi.fn(async (_sessionId: string, _message: Message) => undefined),
  getSession: vi.fn(async () => ({
    messages: [
      {
        id: 'voice-dispatch-1',
        role: 'user',
        content: '整理季度复盘',
        timestamp: 1,
        isMeta: true,
        metadata: { voiceDispatch: { title: '季度复盘', workItemId: 'voice-work-1' } },
      },
      { id: 'assistant-1', role: 'assistant', content: '报告已写入 docs/q3.md。', timestamp: 2 },
    ],
  })),
}));

const log = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: log.warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/services/roleAssets/builtinRoles', () => ({ getBuiltinRoleVisual: () => undefined }));

const { projectVoiceTaskTerminalResult } = await import(
  '../../src/host/services/voice/voiceTaskResultProjector'
);

function item(detail?: string): VoiceWorkItem {
  return {
    id: 'voice-work-1',
    title: '季度复盘',
    status: 'running',
    ...(detail ? { detail } : {}),
  };
}

beforeEach(() => {
  sessionManager.addMessageToSession.mockClear();
  sessionManager.getSession.mockClear();
  log.warn.mockClear();
});

describe('voice task result projector', () => {
  it.each([
    ['done', 'completed'],
    ['unverified', 'unverified'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('把 %s 统一写成 agent-result 终态记录', async (status, projected) => {
    await projectVoiceTaskTerminalResult('session-1', item('用户停止了任务'), status);

    const message = sessionManager.addMessageToSession.mock.calls[0]?.[1];
    expect(message?.metadata?.backgroundTaskResult).toEqual(expect.objectContaining({
      source: 'agent-result',
      taskId: 'voice-work-1',
      shortName: '季度复盘',
      status: projected,
    }));
    expect(message?.content).toContain(`[任务结果] 季度复盘｜${projected}｜`);
    expect(message?.metadata?.voiceWorkSettled).toEqual({
      workItemId: 'voice-work-1',
      title: '季度复盘',
      outcome: status,
    });
  });

  it('settlement 找不到派活锚点时写结构化 host 日志', async () => {
    sessionManager.getSession.mockResolvedValueOnce({
      messages: [{ id: 'assistant-1', role: 'assistant', content: '孤立结论', timestamp: 1 }],
    } as never);

    await projectVoiceTaskTerminalResult('session-missing', item(), 'failed');

    expect(log.warn).toHaveBeenCalledWith(
      'voice work settlement projection target missing',
      expect.objectContaining({
        sessionId: 'session-missing',
        workItemId: 'voice-work-1',
        messageId: expect.stringMatching(/^voice-task-result-/),
        reason: 'voice_dispatch_not_found',
      }),
    );
  });
});
