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
import { hydrateToolCallResults } from '../../../src/renderer/utils/messageHydration';
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
    ['[cancelled]', 'user', '已取消', '你停止了这次执行'],
    ['[未完成 — 切换会话中断]', 'session-switch', '已中断', '切换会话时中断'],
    [null, 'app-restart', '已中断', '应用重启时中断'],
  ] as const)('持久化 resumable 轮按 %s 派生原因，只留一条灰字和一个槽位', (marker, reason, expectedOutcome, expectedReason) => {
    const recovery = snapshot();
    recovery.interruptionReason = reason;
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
    const terminal = reason === 'user' ? expectedOutcome : expectedReason;
    expect(timelineText).toContain(terminal);
    expect(timelineText).toContain('写入 产品设计长文.md');
    expect(timelineText).not.toContain('未执行');
    expect(timelineText).not.toContain('未成功');
    expect(timelineText).not.toContain('/workspace/');
    expect(timelineText.match(new RegExp(terminal, 'gu'))).toHaveLength(1);
    if (reason === 'app-restart') {
      expect(timelineText).not.toContain('已中断 ·');
    }
    expect(screen.getAllByTestId('decision-slot')).toHaveLength(1);
    expect(screen.getByTestId('stream-interruption-decision').textContent)
      .toContain(`上次回复${expectedOutcome}，写入 产品设计长文.md 未执行`);
    expect(document.body.textContent).not.toContain('写入失败');
    expect(document.body.textContent).not.toContain('已中断，可继续');
    expect(document.body.textContent).not.toContain('[cancelled]');
    expect(document.body.textContent).not.toContain('[未完成 — 切换会话中断]');
    expect(document.body.textContent).not.toContain('会改文件');
    expect(document.body.textContent).not.toContain('可重新运行');
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.queryByTestId('streaming-state-banner')).toBeNull();
    expect(document.body.textContent).not.toContain('信号传输中，正在等待模型回响');
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
    expect(step.textContent).not.toContain('未执行');
    expect(step.textContent).not.toContain('未成功');
    expect(step.textContent).not.toContain('你停止了这次执行');
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
    expect(screen.getByTestId('interrupt-timeline-step').textContent).toContain('已取消');
    expect(screen.getByTestId('interrupt-timeline-step').textContent).not.toContain('你停止了这次执行');
    expect(document.body.textContent).not.toContain('已编辑 1 个文件');
    expect(document.body.textContent).not.toContain('准备写入');
    expect(document.body.textContent).not.toContain('信号传输中，正在等待模型回响');
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
    expect(step.textContent).toContain('应用重启时中断');
    expect(step.textContent).not.toContain('已取消');
    expect(step.textContent).not.toContain('已中断 ·');
    expect(step.textContent).not.toContain('未执行');
    expect(step.textContent).toContain('写入一个文件');
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

  // FU3-FU1-FU1 真跑形状（sheet 卡，messages-sheet.json 摘形）：活 run 中途快照重灌
  // 给已完成迭代挂上 recovery 标记，重试成功的 excel_generate 与 DocEdit 的真身
  // （带成功 result）被 interruptedToolCallIds 顶掉，读成「应用重启时中断」。
  // 护栏不变量：recovery 节点只接管「无任何持久化执行结果」的调用。
  // 真身的 result 直接内联在真身消息上（不经 tool 消息水合），recovery 消息上的
  // 同 id 调用保持无 result——这样投影必须以真身为源，不许 recovery 顶替。
  it('recovery 标记不得顶掉已成功执行的工具行（FU3-FU1-FU1 真跑形状）', () => {
    const messages = hydrateToolCallResults([
      { id: 'u-1', role: 'user', content: '分析一组销售数据', timestamp: 1 },
      {
        id: 'a-iter1', role: 'assistant', content: '先测算再生成工作簿。', timestamp: 20,
        metadata: { correlation: { turnId: 'turn-failed-first' } },
        toolCalls: [{ id: 'call-excel-1', name: 'excel_generate', arguments: { data: '...' } }],
      },
      {
        id: 'tool-iter1', role: 'tool', content: '[]', timestamp: 25,
        toolResults: [{ toolCallId: 'call-excel-1', success: false, error: '未能解析出有效数据：JSON 数据里含有特殊字符' }],
      },
      {
        // 重灌留下的 recovery 消息：id=快照 turnId，挂着同 id 调用（无 result）
        id: 'turn-retry', role: 'assistant', content: '调整数据格式后重试。', timestamp: 40,
        metadata: { streamRecovery: { turnId: 'turn-retry' } },
        toolCalls: [{ id: 'call-excel-2', name: 'excel_generate', arguments: { data: '...' } }],
      },
      {
        // 同一 tool call 的真身已执行成功（result 内联，不靠 tool 消息水合）
        id: 'a-iter2', role: 'assistant', content: '', timestamp: 45,
        metadata: { correlation: { turnId: 'turn-retry' } },
        toolCalls: [{
          id: 'call-excel-2', name: 'excel_generate', arguments: { data: '...' },
          result: { toolCallId: 'call-excel-2', success: true, output: '已生成 月度销售分析_2024上半年.xlsx' },
        }],
      },
      {
        id: 'turn-docedit', role: 'assistant', content: '追加汇总分析工作表。', timestamp: 60,
        metadata: { streamRecovery: { turnId: 'turn-docedit' } },
        toolCalls: [{ id: 'call-docedit', name: 'DocEdit', arguments: { path: '月度销售分析_2024上半年.xlsx' } }],
      },
      {
        id: 'a-iter3', role: 'assistant', content: '', timestamp: 65,
        metadata: { correlation: { turnId: 'turn-docedit' } },
        toolCalls: [{
          id: 'call-docedit', name: 'DocEdit', arguments: { path: '月度销售分析_2024上半年.xlsx' },
          result: { toolCallId: 'call-docedit', success: true, output: '写入汇总分析工作表完成' },
        }],
      },
      { id: 'a-final', role: 'assistant', content: '两步写入均已成功，目标已全部完成。', timestamp: 80 },
    ] satisfies Message[]);
    const projection = projectTurns(messages, 'session-1', false);
    const toolNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'tool_call');

    // 每个 tool call 恰好一行，行行以真身消息为源（messageId 指向真身，recovery 不顶替）
    expect(toolNodes.map((node) => node.id).sort()).toEqual([
      'a-iter1-tc-call-excel-1',
      'a-iter2-tc-call-excel-2',
      'a-iter3-tc-call-docedit',
    ]);
    for (const node of toolNodes) {
      expect(node.metadata?.streamRecovery).toBeUndefined();
    }
    const excelRetry = toolNodes.find((node) => node.toolCall?.id === 'call-excel-2');
    expect(excelRetry?.toolCall?.success).toBe(true);
    const docEdit = toolNodes.find((node) => node.toolCall?.id === 'call-docedit');
    expect(docEdit?.toolCall?.success).toBe(true);

    for (const node of toolNodes) {
      render(<TraceNodeRenderer node={node} sessionId="session-1" />);
    }
    expect(document.body.textContent).not.toContain('应用重启时中断');
    expect(document.body.textContent).not.toContain('已中断');
    expect(screen.queryAllByTestId('interrupt-timeline-step')).toHaveLength(0);
  });

  it('真实执行失败的调用也不被 recovery 标记顶掉（失败结果=已执行）', () => {
    const messages = hydrateToolCallResults([
      { id: 'u-1', role: 'user', content: '生成表格', timestamp: 1 },
      {
        id: 'turn-recovery', role: 'assistant', content: '', timestamp: 20,
        metadata: { streamRecovery: { turnId: 'turn-recovery' } },
        toolCalls: [{ id: 'call-failed', name: 'excel_generate', arguments: { data: '...' } }],
      },
      {
        id: 'tool-1', role: 'tool', content: '[]', timestamp: 25,
        toolResults: [{ toolCallId: 'call-failed', success: false, error: '未能解析出有效数据：JSON 数据里含有特殊字符' }],
      },
    ] satisfies Message[]);
    const toolNodes = projectTurns(messages, 'session-1', false).turns
      .flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'tool_call');

    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].toolCall?.id).toBe('call-failed');
    expect(toolNodes[0].toolCall?.success).toBe(false);
    render(<TraceNodeRenderer node={toolNodes[0]} sessionId="session-1" />);
    expect(document.body.textContent).not.toContain('应用重启时中断');
  });

  it('取消清算占位不算执行结果：recovery 仍接管（维持单信号契约）', () => {
    const messages = hydrateToolCallResults([
      { id: 'u-1', role: 'user', content: '写长文', timestamp: 1 },
      {
        id: 'turn-recovery', role: 'assistant', content: '准备写入', timestamp: 20,
        metadata: { streamRecovery: { turnId: 'turn-recovery' } },
        toolCalls: [{ id: 'call-cancelled', name: 'Write', arguments: { file_path: '/workspace/产品设计长文.md' } }],
      },
      {
        id: 'tool-1', role: 'tool', content: '[]', timestamp: 25,
        toolResults: [{
          toolCallId: 'call-cancelled',
          success: false,
          error: '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]',
        }],
      },
    ] satisfies Message[]);
    const toolNodes = projectTurns(messages, 'session-1', false).turns
      .flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'tool_call');

    // snapshot 是未执行的展示权威源：占位清算不成真身行
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].metadata?.streamRecovery?.turnId).toBe('turn-recovery');
    render(<TraceNodeRenderer node={toolNodes[0]} sessionId="session-1" />);
    expect(screen.getAllByTestId('interrupt-timeline-step')).toHaveLength(1);
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
