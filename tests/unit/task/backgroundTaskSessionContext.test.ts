import { describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession }),
}));

const { getBackgroundTaskSessionContext } = await import(
  '../../../src/host/task/backgroundTaskSessionContext'
);

describe('backgroundTaskSessionContext', () => {
  it('inherits foreground history but excludes sibling auxiliary messages', async () => {
    getSession.mockResolvedValue({
      workingDirectory: '/tmp/project',
      messages: [
        { id: 'voice-user', role: 'user', content: '派两件活', timestamp: 1 },
        { id: 'task-a-user', role: 'user', content: '任务 A', timestamp: 2, isMeta: true },
        { id: 'task-a-tool', role: 'tool', content: 'A 的工具结果', timestamp: 3, isMeta: true },
      ],
    });

    await expect(getBackgroundTaskSessionContext('session-1')).resolves.toEqual({
      workingDirectory: '/tmp/project',
      messages: [{ id: 'voice-user', role: 'user', content: '派两件活', timestamp: 1 }],
    });
  });

  it('does not replay a consumed voice dispatch command into the auxiliary run', async () => {
    getSession.mockResolvedValue({
      messages: [
        {
          id: 'voice-dispatch',
          role: 'user',
          content: '请调用 spawn task 派发报告，任务内容是先问我是否继续',
          timestamp: 1,
          metadata: { source: 'voice', voiceTranscript: { itemId: 'voice-item-1' } },
        },
        {
          id: 'voice-context',
          role: 'user',
          content: '报告要覆盖今天的数据',
          timestamp: 2,
          metadata: { source: 'voice', voiceTranscript: { itemId: 'voice-item-2' } },
        },
        { id: 'typed-context', role: 'user', content: '保留原格式', timestamp: 3 },
      ],
    });

    await expect(getBackgroundTaskSessionContext('session-voice')).resolves.toEqual({
      messages: [
        expect.objectContaining({ id: 'voice-context' }),
        expect.objectContaining({ id: 'typed-context' }),
      ],
    });
  });
});
