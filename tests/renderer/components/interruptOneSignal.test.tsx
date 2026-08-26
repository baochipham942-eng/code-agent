// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message, StreamRecoverySnapshot } from '../../../src/shared/contract';

const appState = {
  processingSessionIds: new Set<string>(),
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  openPreview: vi.fn(),
};

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string | null }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: never[] }) => unknown) => selector({ tasks: [] }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null }),
}));
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';

function snapshot(): StreamRecoverySnapshot {
  return {
    sessionId: 'session-1',
    turnId: 'snapshot-turn-1',
    content: '',
    reasoning: '',
    toolCalls: [{
      id: 'write-call-1',
      name: 'Write',
      arguments: '{"file_path":"/workspace/产品设计长文.md","content":"..."}',
    }],
    estimatedTokens: 0,
    timestamp: 30,
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('N-INTERRUPT-ONESIGNAL', () => {
  it('同一 Write 的旧失败节点被 recovery 终态覆盖，渲染树只留一条灰字和一个槽位', () => {
    const recovery = snapshot();
    const messages: Message[] = [
      { id: 'u-1', role: 'user', content: '写长文', timestamp: 1 },
      {
        id: 'a-failed',
        role: 'assistant',
        content: '',
        timestamp: 20,
        toolCalls: [{
          id: 'write-call-1',
          name: 'Write',
          arguments: { file_path: '/workspace/产品设计长文.md' },
          result: { toolCallId: 'write-call-1', success: false, error: 'cancelled before execution' },
        }],
      },
      {
        id: recovery.turnId,
        role: 'assistant',
        content: '',
        timestamp: recovery.timestamp,
        toolCalls: [{
          id: 'write-call-1',
          name: 'Write',
          arguments: { file_path: '/workspace/产品设计长文.md', content: '...' },
        }],
        metadata: { streamRecovery: { turnId: recovery.turnId } },
      },
    ];
    const projection = projectTurns(messages, 'session-1', false);
    const toolNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'tool_call');
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].toolCall?.success).toBeUndefined();
    expect(toolNodes[0].metadata?.streamRecovery?.turnId).toBe(recovery.turnId);

    const retryMessage = messages[0];
    render(
      <>
        <TraceNodeRenderer node={toolNodes[0]} sessionId="session-1" />
        <DecisionSlot
          streamInterruption={{ snapshot: recovery, retryMessage, onContinue: vi.fn().mockResolvedValue(true) }}
        />
      </>,
    );

    expect(screen.getAllByTestId('interrupt-timeline-step')).toHaveLength(1);
    const timelineText = screen.getByTestId('interrupt-timeline-step').textContent ?? '';
    expect(timelineText).toContain('已中断');
    expect(timelineText).toContain('写入 /workspace/产品设计长文.md');
    expect(timelineText).toContain('未执行');
    expect(timelineText.match(/已中断/gu)).toHaveLength(1);
    expect(screen.getAllByTestId('decision-slot')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('写入失败');
    expect(document.body.textContent).not.toContain('已中断，可继续');
    expect(document.body.textContent).not.toContain('会改文件');
    expect(document.body.textContent).not.toContain('可重新运行');
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.queryByTestId('streaming-state-banner')).toBeNull();
  });
});
