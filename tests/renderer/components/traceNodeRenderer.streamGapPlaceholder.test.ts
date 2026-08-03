import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

function makeAssistantTextNode(overrides: Partial<TraceNode> = {}): TraceNode {
  return {
    id: 'a1-text',
    type: 'assistant_text',
    content: '',
    timestamp: 100,
    ...overrides,
  } as TraceNode;
}

// 排查报告 §2 序列②：活动轮里「thinking 已结束但 content 尚空」的窗口，思考指示已灭、
// 空壳守卫又让节点整节点不渲染——用户看到彻底空白。改法只在这条活动轮窗口渲染占位，
// 别的空壳状态（仍在思考、历史消息）保持原样不渲染。
describe('TraceNodeRenderer 活动轮空窗占位（排查报告 §2 序列②）', () => {
  it('活动轮：content 空、thinking 也空 → 渲染「正在组织回答…」占位', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: makeAssistantTextNode(),
        isStreaming: true,
      }),
    );

    expect(html).toContain('正在组织回答');
  });

  it('活动轮：content 空、thinking 非空（仍在思考中）→ 不渲染占位，交给思考指示自己讲', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: makeAssistantTextNode({ thinking: '正在琢磨怎么回答' }),
        isStreaming: true,
      }),
    );

    expect(html).not.toContain('正在组织回答');
  });

  it('活动轮：content 到达后 → 占位消失，正文正常渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: makeAssistantTextNode({ content: '需要我做什么？' }),
        isStreaming: true,
      }),
    );

    expect(html).not.toContain('正在组织回答');
    expect(html).toContain('需要我做什么');
  });

  it('历史消息（非活动轮）：content 空的空壳节点仍然整节点不渲染，占位不介入', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: makeAssistantTextNode(),
        isStreaming: false,
      }),
    );

    expect(html).not.toContain('正在组织回答');
    // 空壳守卫行为不变：外层 trace-node 容器仍在，但内容为空。
    expect(html).toBe('<div data-trace-node-id="a1-text" data-trace-node-type="assistant_text"></div>');
  });
});
