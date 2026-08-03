// @vitest-environment jsdom
// ============================================================================
// 路由异常卡（RoutingEvidenceNode）：异常（warning/error）铺进主对话流，正常
// （success/info/neutral）不铺——正常路由每轮内容一样，铺出来是噪声。
// 原「路由异常」卡随 TaskMonitor 删除后异常曾长期对用户隐形，本测试守住两半：
// 能出现（error/warning）+ 不乱出现（success/info）。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { TurnRoutingEvidence, TurnTimelineTone } from '../../../src/shared/contract/turnTimeline';

function makeNode(tone: TurnTimelineTone, routingEvidence: TurnRoutingEvidence): TraceNode {
  return {
    id: 'turn-1-routing-evidence',
    type: 'turn_timeline',
    content: '',
    timestamp: 1000,
    turnTimeline: {
      id: 'turn-1-routing-evidence',
      kind: 'routing_evidence',
      timestamp: 1000,
      tone,
      routingEvidence,
    },
  } as TraceNode;
}

const errorEvidence: TurnRoutingEvidence = {
  mode: 'auto',
  summary: '指定的 code-reviewer 不可用，已回落默认执行',
  agentIds: ['default'],
  agentNames: ['默认助手'],
  reason: 'agent_not_found',
  steps: [
    { status: 'requested', label: '请求 code-reviewer 执行', tone: 'info', timestamp: 900 },
    { status: 'missing', label: 'code-reviewer 未注册', detail: '注册表里找不到该 agent', tone: 'error', timestamp: 950 },
    { status: 'fallback', label: '回落默认助手', tone: 'warning', timestamp: 1000 },
  ],
};

const successEvidence: TurnRoutingEvidence = {
  mode: 'direct',
  summary: 'Direct 已发送给 code-reviewer',
  agentIds: ['code-reviewer'],
  agentNames: ['code-reviewer'],
  steps: [
    { status: 'delivered', label: '已送达 code-reviewer', tone: 'success', timestamp: 950 },
  ],
};

describe('路由异常卡 — 异常铺进主对话流，正常不铺', () => {
  it('tone=error：渲染路由异常卡，异常步骤一眼可辨（红文案 + 状态徽章）', () => {
    const html = renderToStaticMarkup(<TraceNodeRenderer node={makeNode('error', errorEvidence)} />);

    expect(html).toContain('路由异常');
    expect(html).toContain('指定的 code-reviewer 不可用，已回落默认执行');
    expect(html).toContain('Auto 自动路由');
    expect(html).toContain('默认助手');
    // 步骤全部可见，挂掉那一步是红文案 + 红色圆点
    expect(html).toContain('code-reviewer 未注册');
    expect(html).toContain('text-badge-danger');
    expect(html).toContain('bg-red-400');
    expect(html).toContain('注册表里找不到该 agent');
    expect(html).toContain('未命中');
    expect(html).toContain('已回落');
  });

  it('tone=warning：同样渲染（warning 也是异常态）', () => {
    const html = renderToStaticMarkup(
      <TraceNodeRenderer node={makeNode('warning', { ...errorEvidence, summary: 'Direct 已发送，部分目标未命中' })} />,
    );

    expect(html).toContain('路由异常');
    expect(html).toContain('Direct 已发送，部分目标未命中');
    expect(html).toContain('border-badge-warning/20');
  });

  it('tone=success：正常路由不铺进主对话流（每轮一样，是噪声）', () => {
    const html = renderToStaticMarkup(<TraceNodeRenderer node={makeNode('success', successEvidence)} />);

    expect(html).not.toContain('路由异常');
    expect(html).not.toContain('Direct 已发送给 code-reviewer');
    expect(html).not.toContain('已送达 code-reviewer');
  });

  it('tone=info：同样不铺（无异常信号时的默认 tone）', () => {
    const html = renderToStaticMarkup(<TraceNodeRenderer node={makeNode('info', successEvidence)} />);

    expect(html).not.toContain('路由异常');
    expect(html).not.toContain('Direct 已发送给 code-reviewer');
  });
});
