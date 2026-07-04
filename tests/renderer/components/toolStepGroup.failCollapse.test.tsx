// 失败/部分失败的工具组默认不展开：反爬墙/限流类抓取失败是噪音，
// 不该把组强制撑开成一面报错墙——组头状态徽标已传达失败，用户需要时再点开。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { TraceNode } from '../../../src/shared/contract/trace';

let nid = 0;
function toolNode(name: string, success: boolean, result?: string): TraceNode {
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
      result: result ?? (success ? 'ok' : 'anti-scraping wall'),
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

  it('非网络工具组的探索性失败（Bash 非零退出码，未分类错误）仍展开（既有透明度机制不变），但不顶红', () => {
    // 展开策略本身不变（这是被 browserComputerActionPreview.rendering 测试锁定的既有设计：
    // 折叠会让"哪些找到了/哪些失败了"的信息完全消失，不只是变安静）。本次改动只降噪颜色：
    // 探索性失败（未被 humanizeToolError 分类）用中性色，不喊红。
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('Bash', false, 'command failed with exit code 1')]} />,
    );
    expect(html).toContain(EXPANDED_MARKER);
    expect(html).not.toContain('bg-red-400');
    expect(html).not.toContain('text-red-300');
  });

  it('非网络工具组的真正需要介入的失败（鉴权失效）仍展开并顶红', () => {
    const html = renderToStaticMarkup(
      <ToolStepGroup nodes={[toolNode('Bash', false, '401 Unauthorized: invalid api key')]} />,
    );
    expect(html).toContain(EXPANDED_MARKER);
    expect(html).toContain('bg-red-400');
    expect(html).toContain('text-red-300');
  });
});
