// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { mergeStreamSnapshotIntoMessages } from '../../../src/renderer/utils/streamRecoveryMessage';

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
  it.each([
    ['[cancelled]', '你停止了这次执行'],
    ['[未完成 — 切换会话中断]', '切换会话时中断'],
    [null, '应用重启时中断'],
  ] as const)('持久化 resumable 轮按 %s 派生原因，只留一条灰字和一个槽位', (marker, expectedReason) => {
    const recovery = snapshot();
    const persistedMessages: Message[] = [
      { id: 'u-1', role: 'user', content: '写长文', timestamp: 1 },
      ...(marker ? [{
        id: 'a-failed',
        role: 'assistant',
        content: `已经起草了一部分\n\n${marker}`,
        timestamp: 20,
        toolCalls: [{
          id: 'write-call-1',
          name: 'Write',
          arguments: { file_path: '/workspace/产品设计长文.md' },
          result: { toolCallId: 'write-call-1', success: false, error: 'cancelled before execution' },
        }],
      } satisfies Message] : []),
    ];
    const messages = mergeStreamSnapshotIntoMessages(persistedMessages, recovery);
    const projection = projectTurns(messages, 'session-1', false);
    const toolNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'tool_call');
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].toolCall?.success).toBeUndefined();
    expect(toolNodes[0].metadata?.streamRecovery?.turnId).toBe(recovery.turnId);

    const retryMessage = persistedMessages[0];
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
    expect(timelineText).toContain('已取消');
    expect(timelineText).toContain('写入 产品设计长文.md');
    expect(timelineText).toContain('未执行');
    expect(timelineText).toContain(expectedReason);
    expect(timelineText).not.toContain('/workspace/');
    expect(timelineText.match(/已取消/gu)).toHaveLength(1);
    expect(screen.getAllByTestId('decision-slot')).toHaveLength(1);
    expect(screen.getByTestId('stream-interruption-decision').textContent)
      .toContain('上次回复中断，写入 产品设计长文.md 未执行');
    expect(document.body.textContent).not.toContain('写入失败');
    expect(document.body.textContent).not.toContain('已中断，可继续');
    expect(document.body.textContent).not.toContain('[cancelled]');
    expect(document.body.textContent).not.toContain('[未完成 — 切换会话中断]');
    expect(document.body.textContent).not.toContain('会改文件');
    expect(document.body.textContent).not.toContain('可重新运行');
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.queryByTestId('streaming-state-banner')).toBeNull();
  });

  it('主动停止留下的原始 ToolCallDisplay 使用 basename 并带停止原因', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          id: 'write-call-direct',
          name: 'Write',
          arguments: { file_path: '/workspace/主动停止.md', content: '...' },
          shortDescription: '写入了一个文件',
        }}
        index={0}
        total={1}
        statusOverride="interrupted"
        interruptionReason="user"
      />,
    );

    const step = screen.getByTestId('interrupt-timeline-step');
    expect(step.textContent).toContain('已取消');
    expect(step.textContent).toContain('写入 主动停止.md');
    expect(step.textContent).toContain('未执行');
    expect(step.textContent).toContain('你停止了这次执行');
    expect(step.textContent).not.toContain('写入了一个文件');
    expect(step.textContent).not.toContain('会改文件');
    expect(step.textContent).not.toContain('可重新运行');
  });

  it('TurnCard 对 replay Write 保留中断行并压掉未执行文件的改动摘要', () => {
    const recovery = snapshot();
    recovery.content = '准备写入';
    const messages = mergeStreamSnapshotIntoMessages([
      { id: 'u-turn', role: 'user', content: '写长文', timestamp: 1 },
      { id: 'a-turn', role: 'assistant', content: '准备写入\n\n[cancelled]', timestamp: 20 },
    ], recovery);
    const turn = projectTurns(messages, 'session-1', false).turns[0];

    render(<TurnCard turn={turn} sessionId="session-1" isLastTurn />);

    expect(screen.getAllByTestId('interrupt-timeline-step')).toHaveLength(1);
    expect(screen.getByTestId('interrupt-timeline-step').textContent).toContain('你停止了这次执行');
    expect(document.body.textContent).not.toContain('已编辑 1 个文件');
    expect(document.body.textContent).not.toContain('准备写入');
  });

  it('Write 缺路径时退为“写入一个文件”且仍带原因', () => {
    render(
      <ToolCallDisplay
        toolCall={{ id: 'write-call-no-path', name: 'Write', arguments: {} }}
        index={0}
        total={1}
        statusOverride="interrupted"
        interruptionReason="app-restart"
      />,
    );

    const step = screen.getByTestId('interrupt-timeline-step');
    expect(step.textContent).toContain('写入一个文件');
    expect(step.textContent).toContain('应用重启时中断');
  });

  it('Write 工具行在错误态展开后也不挂效果或重跑徽标', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          id: 'write-call-failed',
          name: 'Write',
          arguments: { file_path: '/workspace/失败.md', content: '...' },
          result: {
            toolCallId: 'write-call-failed',
            success: false,
            error: 'temporary write failure',
          },
        }}
        index={0}
        total={1}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-row-Write'));
    expect(document.body.textContent).not.toContain('会改文件');
    expect(document.body.textContent).not.toContain('可重新运行');
  });

  it('TurnCard 不再保留 resumable 徽章或橙卡分支', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/features/chat/TurnCard.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/case 'resumable':/u);
    expect(source).not.toContain('RotateCcw');
    expect(source).toContain(
      'isFileChangeCardOwnedNode(node) && !node.metadata?.streamInterruptionReason',
    );
    expect(source).toContain('!hasStreamInterruption && (');
    const copy = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/i18n/chatTranscript.ts'),
      'utf8',
    );
    expect(copy).not.toContain('已中断，可继续');
    expect(copy).not.toContain('上次流式输出未完成，可从会话操作里继续');
  });
});
