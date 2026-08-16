import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/shared/contract/message';
import type { ToolResult } from '../../src/shared/contract/tool';
import type { VoiceWorkItem } from '../../src/shared/contract/voice';

const sessionManager = vi.hoisted(() => ({
  addMessageToSession: vi.fn(async (_sessionId: string, _message: Message) => undefined),
  getSession: vi.fn(async () => ({
    messages: [{ id: 'assistant-1', role: 'assistant', content: '报告已写入 docs/q3.md。', timestamp: 1 }],
  })),
}));

vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

const ledgerResults: ToolResult[] = [
  {
    toolCallId: 'write-1',
    success: true,
    output: 'wrote file',
    metadata: {
      artifacts: [{
        artifactId: 'artifact-12-md',
        kind: 'document',
        role: 'deliverable',
        sourceTool: 'Write',
        createdAt: '2026-08-16T00:00:00.000Z',
        path: '/repo/12.md',
        name: '12.md',
      }],
    },
  },
  {
    toolCallId: 'read-1',
    success: true,
    metadata: {
      artifacts: [{
        artifactId: 'source-notes',
        kind: 'text',
        role: 'material',
        sourceTool: 'Read',
        createdAt: '2026-08-16T00:00:00.000Z',
        path: '/repo/source.md',
      }],
    },
  },
];

beforeEach(() => {
  sessionManager.addMessageToSession.mockClear();
  sessionManager.getSession.mockClear();
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
    if (status === 'done' || status === 'unverified') {
      expect(message?.metadata?.voiceWorkSettled).toEqual({
        workItemId: 'voice-work-1',
        title: '季度复盘',
        outcome: status,
      });
    } else {
      expect(message?.metadata?.voiceWorkSettled).toBeUndefined();
    }
  });

  it.each(['done', 'unverified', 'failed'] as const)(
    '%s 终态只投影该 run 工具账本里的文件产物',
    async (status) => {
      await projectVoiceTaskTerminalResult(
        'session-1',
        item(),
        status,
        undefined,
        '摘要里故意写另一个文件 fake.md',
        ledgerResults,
      );

      const message = sessionManager.addMessageToSession.mock.calls[0]?.[1];
      expect(message?.metadata?.backgroundTaskResult?.artifacts).toEqual([
        expect.objectContaining({
          path: '/repo/12.md',
          label: '12.md',
          sourceTool: 'Write',
          role: 'deliverable',
        }),
      ]);
      expect(message?.metadata?.backgroundTaskResult?.artifacts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/repo/fake.md' })]),
      );
    },
  );

  it('无工具账本产物时不写空 artifacts', async () => {
    await projectVoiceTaskTerminalResult('session-1', item(), 'done', undefined, '纯问答完成', []);

    const message = sessionManager.addMessageToSession.mock.calls[0]?.[1];
    expect(message?.metadata?.backgroundTaskResult).not.toHaveProperty('artifacts');
  });
});
