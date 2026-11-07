// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { getToolStatus } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/styles';
import { getToolStatusLabel } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';
import { buildToolStatusLineCopy } from '../../../src/renderer/utils/toolStatusLinePresentation';
import { languages } from '../../../src/renderer/i18n';

// FB-595：回合收尾（会话不在 processingSessionIds）后，无 result 的调用不能再用
// 进行时渲染——折叠头曾与展开行各说各话（头「运行中 · 正在运行命令 ls …」，行「已中断」）。
// 这里渲染真实 ToolStepGroup + 真实 app store，钉住两个状态源同一口径：
// 折叠头文本 === 展开行（getToolStatus → statusLabels / buildToolStatusLineCopy）对同一
// 调用装配出的那一行。普通失败（Read success:false + 错误结果）的头文案另行回归钉死，
// 不随陈旧收口改动漂移。

function staleBashNode(id: string, timestamp: number): TraceNode {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp,
    toolCall: {
      id: `${id}-call`,
      name: 'Bash',
      args: { command: 'ls' },
      // 无 result：回合结束时这一步没有落回任何结果
    },
  } as TraceNode;
}

function finishedReadNode(id: string, timestamp: number): TraceNode {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp,
    toolCall: {
      id: `${id}-call`,
      name: 'Read',
      args: { file_path: '/work/notes.md' },
      success: true,
      result: 'ok',
    },
  } as TraceNode;
}

function failedReadNode(id: string, timestamp: number): TraceNode {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp,
    toolCall: {
      id: `${id}-call`,
      name: 'Read',
      args: { file_path: '/work/notes.md' },
      success: false,
      result: 'ENOENT: no such file or directory, open /work/notes.md',
    },
  } as TraceNode;
}

// 与 ToolStepGroup 展开档（toolCalls memo）同构的 ToolCall 形状，喂给展开行同一批
// 判定/装配函数（getToolStatus、getToolStatusLabel、buildToolStatusLineCopy）。
function toolCallOf(node: TraceNode): ToolCall {
  const tc = node.toolCall!;
  return {
    id: tc.id,
    name: tc.name,
    arguments: tc.args,
    shortDescription: tc.shortDescription,
    stepLabel: tc.stepLabel,
    result: tc.result === undefined
      ? undefined
      : {
          toolCallId: tc.id,
          success: tc.success ?? true,
          output: tc.success !== false ? tc.result : undefined,
          error: tc.success === false ? tc.result : undefined,
        },
  } as ToolCall;
}

const headLabelText = () => screen.getByTestId('tool-group-head-label').textContent ?? '';

describe('ToolStepGroup — stale running header (FB-595)', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ processingSessionIds: new Set<string>(), isProcessing: false });
    useSessionStore.setState({ currentSessionId: null });
  });

  it('(a) idle session + result-less Bash: collapsed header equals the expanded-row interrupted line', () => {
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), isProcessing: false });
    useSessionStore.setState({ currentSessionId: 'sess-stale-a' });
    const node = staleBashNode('tool-a', 1_000);
    render(<ToolStepGroup nodes={[node]} sessionId="sess-stale-a" defaultExpanded />);

    // 展开行的状态判定（ToolCallDisplay/styles.ts getToolStatus）：同一输入必须落到
    // 'interrupted'——这是两个状态源同判定的锚点。
    const tc = toolCallOf(node);
    const idleSessionIds = new Set<string>();
    const expandedStatus = getToolStatus(tc, 'sess-stale-a', idleSessionIds);
    expect(expandedStatus).toBe('interrupted');

    // 展开行的两段文案（statusLabels.ts 的状态词 + ToolHeader 用的同一装配器）
    const t = languages.zh;
    const expandedLabel = getToolStatusLabel(tc, expandedStatus, t);
    const expandedLine = buildToolStatusLineCopy({ status: expandedStatus, toolCall: tc }, t);
    expect(expandedLabel).toBe('已中断');
    expect(expandedLine.line).toBe(`${expandedLabel} · ${expandedLine.action}`);

    const header = headLabelText();
    expect(header).not.toContain('运行中');
    expect(header).not.toContain('正在运行命令');
    // 折叠头 === 展开行装配线：同一结局词、同一动作短语、同一句
    expect(header).toBe(expandedLine.line);

    // 真实展开行 DOM（ToolCallDisplay → ToolHeader）确实渲染这两段
    const headerBlock = screen.getByTestId('tool-call-row-Bash').children[1] as HTMLElement;
    const parts = Array.from(headerBlock.children)
      .map((child) => (child.textContent ?? '').trim())
      .filter(Boolean);
    expect(parts[0]).toBe(`${expandedLabel} ·`);
    expect(parts[1]).toBe(expandedLine.action);
  });

  it('(b) live session keeps the running header as today', () => {
    useAppStore.setState({
      language: 'zh',
      processingSessionIds: new Set(['sess-live-b']),
      isProcessing: true,
    });
    render(<ToolStepGroup nodes={[staleBashNode('tool-b', 2_000)]} sessionId="sess-live-b" />);
    const text = headLabelText();
    expect(text).toContain('运行中 · ');
    expect(text).toContain('正在运行命令');
  });

  it('(c) mixed group (one finished + one result-less) in an idle session: no running wording', () => {
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), isProcessing: false });
    render(
      <ToolStepGroup
        nodes={[finishedReadNode('tool-c1', 3_000), staleBashNode('tool-c2', 4_000)]}
        sessionId="sess-mixed-c"
      />,
    );
    const text = headLabelText();
    expect(text).not.toContain('运行中');
    expect(text).toContain('已中断');
  });

  it('(d) failed Read (idle session): header keeps the plain failure wording, never the interrupted label', () => {
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), isProcessing: false });
    useSessionStore.setState({ currentSessionId: 'sess-readfail-d' });
    render(<ToolStepGroup nodes={[failedReadNode('tool-d', 5_000)]} sessionId="sess-readfail-d" />);
    const text = headLabelText();
    // origin/main 的普通失败头：读取 … 未成功（不带错误码——错误码走组头失败原因行，不进步骤行）
    expect(text).toBe('读取 /work/notes.md 未成功');
    expect(text).not.toContain('已中断');
    expect(text).not.toContain('运行中');
  });

  it('(e) failed Read (live session): same failure wording as idle — finished calls ignore liveness', () => {
    useAppStore.setState({
      language: 'zh',
      processingSessionIds: new Set(['sess-readfail-e']),
      isProcessing: true,
    });
    render(<ToolStepGroup nodes={[failedReadNode('tool-e', 6_000)]} sessionId="sess-readfail-e" />);
    const text = headLabelText();
    expect(text).toBe('读取 /work/notes.md 未成功');
    expect(text).not.toContain('已中断');
  });
});
