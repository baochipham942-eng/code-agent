import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => content,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index', () => ({
  ToolCallDisplay: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({
  AttachmentDisplay: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ExpandableContent', () => ({
  ExpandableContent: () => null,
}));

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

// 注入卫生工单（2026-08-01）修 2：design-acceptance-contract-json / design-code-handoff-json /
// design-brief-json 等 reminder 仍走 renderer 侧 prepend 进发出的 content（本单不动传输通道），
// 但用户气泡渲染时必须剥掉这些块，只显示用户真实文本。修在 UserNode 这一个 chokepoint。
describe('TraceNodeRenderer 用户消息剥离 <system-reminder> 块', () => {
  it('剥掉 reminder 块，只显示用户真实文本', () => {
    const node: TraceNode = {
      id: 'user-reminder-1',
      type: 'user',
      content: [
        '<system-reminder kind="design-acceptance-contract-json">',
        '当前 turn 携带验收/约束契约：这是给 agent 收敛产物的隐藏意图。',
        '{"contract":"secret-payload"}',
        '</system-reminder>',
        '',
        '帮我把这个按钮改成蓝色',
      ].join('\n'),
      timestamp: 100,
    };

    const html = renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node }));

    expect(html).toContain('帮我把这个按钮改成蓝色');
    expect(html).not.toContain('<system-reminder');
    expect(html).not.toContain('&lt;system-reminder');
    expect(html).not.toContain('secret-payload');
    expect(html).not.toContain('隐藏意图');
  });

  it('多个 reminder 块（design-brief + design-code-handoff）都被剥掉', () => {
    const node: TraceNode = {
      id: 'user-reminder-2',
      type: 'user',
      content: [
        '<system-reminder kind="design-brief-json">',
        '{"brief":"a"}',
        '</system-reminder>',
        '',
        '<system-reminder kind="design-code-handoff-json">',
        '{"handoff":"b"}',
        '</system-reminder>',
        '',
        '继续',
      ].join('\n'),
      timestamp: 100,
    };

    const html = renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node }));

    expect(html).toContain('继续');
    expect(html).not.toContain('<system-reminder');
    expect(html).not.toContain('"brief"');
    expect(html).not.toContain('"handoff"');
  });

  it('纯文本消息不受影响', () => {
    const node: TraceNode = {
      id: 'user-plain-1',
      type: 'user',
      content: '这是一条普通消息，不含任何隐藏块',
      timestamp: 100,
    };

    const html = renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node }));

    expect(html).toContain('这是一条普通消息，不含任何隐藏块');
  });

  it('剥离只影响展示：node.content（存储侧原文）不被组件改写', () => {
    const rawContent = [
      '<system-reminder kind="design-brief-json">',
      '{"brief":"a"}',
      '</system-reminder>',
      '',
      '看看这份文案',
    ].join('\n');
    const node: TraceNode = {
      id: 'user-reminder-3',
      type: 'user',
      content: rawContent,
      timestamp: 100,
    };

    renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node }));

    // 组件是纯函数式渲染，node 对象本身（即存储侧原文）必须原封不动。
    expect(node.content).toBe(rawContent);
  });
});
