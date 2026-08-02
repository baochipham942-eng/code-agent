// @vitest-environment jsdom
// ============================================================================
// TurnCard Hooks banner：决策原因上屏 + 颜色语义（决策 amber / 出错才红）+ running 态
// ============================================================================
// 颜色语义：「拦下」「改写输入」是 hook 的正常决策 → amber；只有 hook 自身执行
// 出错才用红。reason 是 block/modify 的单行决策摘要（host 侧已截断+脱敏），
// 折叠行单条拦截直接带原因，展开里每条触发一行原因。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import type { TurnHookActivity } from '../../../src/shared/contract/turnTimeline';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
  getRunningToolStartTime: () => null,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => undefined,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

function turnWithHookActivity(hookActivity: TurnHookActivity): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 220,
    nodes: [
      { id: 'user-1', type: 'user', content: '跑一下', timestamp: 100 },
      {
        id: 'turn-1-hook-activity',
        type: 'turn_timeline',
        content: '',
        timestamp: 120,
        turnTimeline: {
          id: 'turn-1-hook-activity',
          kind: 'hook_activity',
          timestamp: 120,
          tone: 'warning',
          hookActivity,
        },
      },
      { id: 'assistant-1', type: 'assistant_text', content: '好了。', timestamp: 220 },
    ],
  };
}

const blockedItem: TurnHookActivity['items'][number] = {
  timestamp: 110,
  event: 'PreToolUse',
  action: 'block',
  hookCount: 1,
  durationMs: 4,
  sources: ['project'],
  hookType: 'decision',
  names: ['命令门禁'],
  toolName: 'Bash',
  reason: '危险命令：rm -rf',
};

afterEach(cleanup);

describe('TurnCard Hooks banner — 决策原因与颜色语义', () => {
  it('单条拦截：折叠行带原因摘要，徽章是 amber 不是红', () => {
    render(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '拦下 1 次 · 工具前 · 命令门禁',
        items: [blockedItem],
      }),
    }));

    const collapsed = screen.getByRole('button', { name: /Hooks/, expanded: false });
    // 折叠行摘要：拦下次数 + 单条原因（host 侧已首行截断）
    expect(collapsed.textContent).toContain('拦下 1 次');
    expect(collapsed.textContent).toContain('原因：危险命令：rm -rf');
    // 决策色 amber；红色只留给 hook 自身执行出错
    expect(collapsed.innerHTML).toContain('bg-amber-500/10');
    expect(collapsed.innerHTML).not.toContain('bg-red-500/10');
  });

  it('多条拦截：折叠行只计数不带原因', () => {
    render(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '拦下 2 次 · 2 个时机 · 命令门禁',
        items: [
          blockedItem,
          { ...blockedItem, timestamp: 150, event: 'Stop' },
        ],
      }),
    }));

    const collapsed = screen.getByRole('button', { name: /Hooks/, expanded: false });
    expect(collapsed.textContent).toContain('拦下 2 次');
    expect(collapsed.textContent).not.toContain('原因：');
  });

  it('展开后每条拦截带一行原因；Stop 拦下措辞是「要求继续」', () => {
    render(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '拦下 1 次 · 停止 · 完成度检查',
        items: [
          {
            ...blockedItem,
            event: 'Stop',
            names: ['完成度检查'],
            toolName: undefined,
            reason: '还有测试没跑完',
          },
        ],
      }),
    }));

    fireEvent.click(screen.getByRole('button', { name: /Hooks/, expanded: false }));

    expect(document.body.textContent).toContain('要求继续');
    expect(document.body.textContent).toContain('原因：还有测试没跑完');
    // 「要求继续」是决策不是错误
    expect(document.body.innerHTML).not.toContain('bg-red-500/10');
  });

  it('hook 自身执行出错才用红徽章', () => {
    render(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '1 个出错 · 工具后 · 审计',
        items: [
          {
            timestamp: 110,
            event: 'PostToolUse',
            action: 'allow',
            hookCount: 1,
            durationMs: 4,
            sources: ['global'],
            hookType: 'observer',
            names: ['审计'],
            errorCount: 1,
          },
        ],
      }),
    }));

    const collapsed = screen.getByRole('button', { name: /Hooks/, expanded: false });
    expect(collapsed.textContent).toContain('1 个出错');
    expect(collapsed.innerHTML).toContain('bg-red-500/10');
  });

  it('running 态：无落账事件时也有一行 shimmer 指示', () => {
    render(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '',
        items: [],
        running: { event: 'PreToolUse', names: ['命令门禁'] },
      }),
    }));

    const indicator = screen.getByTestId('hook-running-indicator');
    expect(indicator.textContent).toContain('正在运行 工具前…');
    expect(indicator.className).toContain('hook-running-enter');
    // >300ms 阈值用 CSS animation-delay 实现，不是 JS 定时器
    expect(indicator.querySelector('.streaming-thinking-shimmer')).toBeTruthy();
    // 没有落账事件时不渲染折叠行
    expect(screen.queryByRole('button', { name: /Hooks/ })).toBeNull();
  });

  it('running 批次落账后（running 消失、items 到位）回到常驻 banner', () => {
    render(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '工具前 · 命令门禁',
        items: [{ ...blockedItem, action: 'allow', reason: undefined }],
      }),
    }));

    expect(screen.queryByTestId('hook-running-indicator')).toBeNull();
    expect(screen.getByRole('button', { name: /Hooks/, expanded: false })).toBeTruthy();
  });
});
