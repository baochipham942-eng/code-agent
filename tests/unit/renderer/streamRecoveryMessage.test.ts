import { describe, expect, it } from 'vitest';
import {
  buildStreamRecoveryMessage,
  isSessionActiveForStreamRecovery,
  isTerminalRecoverySessionStatus,
  mergeStreamSnapshotIntoMessages,
} from '../../../src/renderer/utils/streamRecoveryMessage';
import type { StreamRecoverySnapshot } from '../../../src/shared/contract';

describe('stream recovery session truth', () => {
  it.each(['completed', 'error', 'interrupted', 'orphaned', 'idle'] as const)(
    '%s 终态优先于 registry 尾窗的 activeRun',
    (status) => {
      expect(isTerminalRecoverySessionStatus(status)).toBe(true);
      expect(isSessionActiveForStreamRecovery({ status, activeRun: true })).toBe(false);
    },
  );

  it('真实 running + activeRun 仍保持活动恢复', () => {
    expect(isSessionActiveForStreamRecovery({ status: 'running', activeRun: true })).toBe(true);
  });

  it('半截 Write JSON 保留已完整落快照的 file_path', () => {
    const snapshot: StreamRecoverySnapshot = {
      sessionId: 'session-partial-write',
      turnId: 'turn-partial-write',
      content: '',
      reasoning: '',
      toolCalls: [{
        id: 'write-partial',
        name: 'Write',
        arguments: '{"file_path":"/workspace/reload-proof.md","content":"尚未写完',
      }],
      estimatedTokens: 3,
      timestamp: 1,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['write-partial'],
    };

    expect(buildStreamRecoveryMessage(snapshot).toolCalls?.[0]?.arguments).toEqual({
      file_path: '/workspace/reload-proof.md',
    });
  });

  it('快照原因优先于 marker 尚未回读时的重启兜底', () => {
    const snapshot: StreamRecoverySnapshot = {
      sessionId: 'session-user-stop',
      turnId: 'turn-user-stop',
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'write-stop', name: 'Write', arguments: '{}' }],
      estimatedTokens: 0,
      timestamp: 1,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: [],
      interruptionReason: 'user',
    };

    const messages = mergeStreamSnapshotIntoMessages([
      { id: 'user-1', role: 'user', content: '写文件', timestamp: 0 },
    ], snapshot);

    expect(messages.at(-1)?.metadata?.streamInterruptionReason).toBe('user');
  });
});
