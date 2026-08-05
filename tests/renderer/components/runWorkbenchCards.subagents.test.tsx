// @vitest-environment jsdom

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubagentRunRows } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';

const MEMBERS = [
  {
    id: 'agent-a',
    parentRunId: 'run-1',
    role: '知微',
    status: 'running' as const,
    inputSummary: '拉竞品数据',
    lastOutput: '',
  },
  {
    id: 'agent-b',
    parentRunId: 'run-1',
    role: '青禾',
    status: 'completed' as const,
    inputSummary: '写摘要',
    lastOutput: '已交稿',
  },
];

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

describe('SubagentRunRows', () => {
  it('renders model tags for subagent rows', () => {
    const html = renderToStaticMarkup(
      React.createElement(SubagentRunRows, {
        subagents: [
          {
            id: 'wf-1-a1',
            parentRunId: 'wf-1',
            role: 'Runtime',
            model: 'kimi-k2.5',
            status: 'running',
            inputSummary: '审计 runtime',
            lastOutput: '',
          },
        ],
      }),
    );

    expect(html).toContain('Runtime');
    expect(html).toContain('kimi-k2.5');
    expect(html).toContain('subagent-model-tag');
  });

  // C2（2026-08-05）：概览 Todo 的成员级清单要能点进成员视图。
  it('传入 onSelect 后成员行可点，点击回传该成员 id', () => {
    const onSelect = vi.fn();
    render(React.createElement(SubagentRunRows, { subagents: MEMBERS, onSelect }));

    const rows = screen.getAllByTestId('subagent-run-row');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]);

    expect(onSelect).toHaveBeenCalledWith('agent-b');
  });

  it('不在 selectableIds 里的成员保持静态——点了只会跳进解析不出来的空白页', () => {
    const onSelect = vi.fn();
    render(React.createElement(SubagentRunRows, {
      subagents: MEMBERS,
      onSelect,
      selectableIds: new Set(['agent-a']),
    }));

    const rows = screen.getAllByTestId('subagent-run-row');
    expect(rows[0].getAttribute('data-selectable')).toBe('true');
    expect(rows[1].getAttribute('data-selectable')).toBeNull();

    fireEvent.click(rows[1]);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith('agent-a');
  });

  it('不传 onSelect 时行为不变（静态行，无 role=button）', () => {
    render(React.createElement(SubagentRunRows, { subagents: MEMBERS }));
    for (const row of screen.getAllByTestId('subagent-run-row')) {
      expect(row.getAttribute('role')).toBeNull();
    }
  });
});
