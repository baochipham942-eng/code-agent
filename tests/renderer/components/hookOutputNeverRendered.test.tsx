// @vitest-environment jsdom
// ============================================================================
// hook 的输出内容一个字都不许上屏
// ============================================================================
// 真机 dogfood 抓到：会话里的钩子行把 SessionStart hook 的 stdout 原样渲染，
// 整份记忆索引连 HTML 注释和内部昵称一起漏给了用户。hook stdout 是任意文本，
// 加关键词过滤守不住——守法是让渲染层根本拿不到它。
//
// 这条用真实的泄露内容当探针：只要投影或任一渲染路径把它带回来，就红。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { buildTurnExecutionClarityProjection } from '../../../src/renderer/utils/turnTimelineProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

const LEAKED = '=== MEMORY INDEX (会话记忆系统) === # Memory Index <!-- 内部注释 -->';

function projectionWithHook(): TraceProjection {
  return {
    sessionId: 'session-hook-leak',
    activeTurnIndex: -1,
    turns: [
      {
        turnNumber: 1,
        turnId: 'turn-1',
        status: 'completed',
        startTime: 100,
        endTime: 200,
        nodes: [
          { id: 'user-1', type: 'user', content: '建个文件', timestamp: 100 },
          { id: 'assistant-1', type: 'assistant_text', content: '好了。', timestamp: 190 },
        ],
      },
    ],
  } as TraceProjection;
}

function enrich() {
  return buildTurnExecutionClarityProjection({
    projection: projectionWithHook(),
    capabilities: { skills: [], connectors: [], mcpServers: [] },
    launchRequests: [],
    swarmEvents: [],
    routingEvents: [],
    hookEvents: [
      {
        timestamp: 120,
        event: 'SessionStart',
        action: 'allow',
        durationMs: 30,
        hookCount: 1,
        modified: false,
        sources: ['global'],
        hookType: 'observer',
        names: ['注入人格'],
        // hook 真实吐出来的东西
        message: LEAKED,
      },
    ],
  });
}

describe('hook 输出不上屏', () => {
  it('投影不把 hook 的 stdout 带进 timeline', () => {
    const hookNode = enrich().turns[0]?.nodes.find((node) => node.turnTimeline?.kind === 'hook_activity');
    expect(hookNode).toBeTruthy();

    const serialized = JSON.stringify(hookNode);
    expect(serialized).not.toContain('MEMORY INDEX');
    expect(serialized).not.toContain('<!--');
    // 该显示的仍要显示：哪个时机、是哪个 hook
    expect(serialized).toContain('SessionStart');
    expect(serialized).toContain('注入人格');
  });

  // 两条路径都必须**展开之后**再断言：默认折叠时展开区根本不挂载，静态快照会
  // 假绿——把 message 渲染回去也照样通过（实测过）。
  it('轮次卡的钩子横幅展开后也不含泄露内容', () => {
    const turn = enrich().turns[0]!;
    render(React.createElement(TurnCard, { turn }));

    fireEvent.click(screen.getByRole('button', { name: /Hooks/, expanded: false }));
    expect(document.body.textContent).not.toContain('MEMORY INDEX');
    expect(document.body.textContent).toContain('注入人格');
  });

  it('时间线节点渲染器展开后也不含泄露内容', () => {
    const hookNode = enrich().turns[0]?.nodes
      .find((node) => node.turnTimeline?.kind === 'hook_activity') as TraceNode;
    render(React.createElement(TraceNodeRenderer, { node: hookNode }));

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(document.body.textContent).not.toContain('MEMORY INDEX');
    expect(document.body.textContent).toContain('注入人格');
  });
});

afterEach(cleanup);
