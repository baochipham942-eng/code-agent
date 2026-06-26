import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';

// ToolDetails 依赖 appStore 的两个 selector，mock 掉即可。
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));

import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

function render(toolCall: ToolCall): string {
  return renderToStaticMarkup(React.createElement(ToolDetails, { toolCall }));
}

describe('ToolDetails 语法高亮（#13 收窄版：仅 JSON 走高亮）', () => {
  it('default 分支工具的参数（JSON 转储）走语法高亮', () => {
    // 非结构化工具名 → formatArgs 走 default JSON.stringify 分支
    const markup = render({
      id: 't1',
      name: 'mcp_custom_tool',
      arguments: { query: 'hello', limit: 5 },
    } as ToolCall);
    // react-syntax-highlighter 渲染 <code> + 带颜色的 token span
    expect(markup).toContain('<code');
    expect(markup).toContain('color:');
    expect(markup).toContain('query');
  });

  it('Read 工具的参数（人话标签）保持纯文本 pre，不高亮', () => {
    const markup = render({
      id: 't2',
      name: 'Read',
      arguments: { file_path: '/tmp/a.ts' },
    } as ToolCall);
    expect(markup).toContain('File: /tmp/a.ts');
    // 标签文本块是纯 <pre>，不应出现高亮 <code> token
    expect(markup).not.toContain('<code');
  });

  it('字符串型 result.output（日志/带行号）保持纯文本，不走 JSON 高亮', () => {
    const markup = render({
      id: 't3',
      name: 'Read',
      arguments: { file_path: '/tmp/a.ts' },
      result: { success: true, output: '     1→const x = 1\n     2→const y = 2' },
    } as unknown as ToolCall);
    expect(markup).toContain('const x = 1');
    // 行号前缀的纯文本输出不应被当 JSON 高亮
    expect(markup).not.toContain('color:#');
  });

  it('对象型 result.output 走 JSON 高亮', () => {
    const markup = render({
      id: 't4',
      name: 'mcp_custom_tool',
      arguments: { q: 1 },
      result: { success: true, output: { items: [1, 2, 3], ok: true } },
    } as unknown as ToolCall);
    expect(markup).toContain('<code');
    expect(markup).toContain('items');
    expect(markup).toContain('color:');
  });
});
