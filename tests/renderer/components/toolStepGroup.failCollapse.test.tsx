// 失败/部分失败的工具组默认不展开：反爬墙/限流类抓取失败是噪音，
// 不该把组强制撑开成一面报错墙——组头状态徽标已传达失败，用户需要时再点开。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { TraceNode } from '../../../src/shared/contract/trace';

let nid = 0;
function toolNode(name: string, success: boolean): TraceNode {
  nid += 1;
  return {
    id: `tool-${nid}`,
    type: 'tool_call',
    content: '',
    timestamp: nid,
    toolCall: {
      id: `call-${nid}`,
      name,
      args: { url: `https://site${nid}.com` },
      success,
      result: success ? 'ok' : 'anti-scraping wall',
    },
  } as TraceNode;
}

// 展开态才会渲染的内层容器（每工具 ToolCallDisplay 列表的 border-l 框）
const EXPANDED_MARKER = 'border-l border-zinc-800';

describe('ToolStepGroup — 失败工具组默认折叠', () => {
  it('部分失败（partial：有成功有反爬失败）默认折叠，不撑开报错墙', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('WebFetch', false), toolNode('WebFetch', true)]} />,
    );
    expect(html).not.toContain(EXPANDED_MARKER);
  });

  it('全失败（error）默认也折叠', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('WebFetch', false), toolNode('WebFetch', false)]} />,
    );
    expect(html).not.toContain(EXPANDED_MARKER);
  });

  it('defaultExpanded=true 时仍展开（流式态等显式要求不受影响）', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('WebFetch', true), toolNode('WebFetch', true)]} defaultExpanded />,
    );
    expect(html).toContain(EXPANDED_MARKER);
  });
});
