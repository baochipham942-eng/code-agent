// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// FB-595：回合收尾（会话不在 processingSessionIds）后，无 result 的调用不能再用
// 进行时渲染——折叠头曾与展开行各说各话（头「运行中 · 正在运行命令 ls …」，行「已中断」）。
// 这里渲染真实 ToolStepGroup + 真实 app store，钉住两个状态源同一口径。

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

const headLabelText = () => screen.getByTestId('tool-group-head-label').textContent ?? '';

describe('ToolStepGroup — stale running header (FB-595)', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ processingSessionIds: new Set<string>(), isProcessing: false });
  });

  it('(a) idle session + result-less Bash: header carries the interrupted label, never a running verb', () => {
    useAppStore.setState({ language: 'zh' });
    render(<ToolStepGroup nodes={[staleBashNode('tool-a', 1_000)]} sessionId="sess-stale-a" />);
    const text = headLabelText();
    expect(text).not.toContain('运行中');
    expect(text).not.toContain('正在运行命令');
    expect(text).toContain('已中断');
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
    useAppStore.setState({ language: 'zh' });
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
});
