// ============================================================================
// ToolCallDisplay utils 测试 — 重点覆盖 MCP 工具的 server/tool 名称解析
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  getToolDisplayName,
  formatParams,
} from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/utils';
import type { ToolCall } from '../../../src/shared/contract/tool';

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'tc-1', name, arguments: args };
}

describe('getToolDisplayName — MCP 工具', () => {
  it('已知 server 命中映射表，返回精致显示名', () => {
    expect(getToolDisplayName('mcp_exa_search')).toBe('Exa');
    expect(getToolDisplayName('mcp_firecrawl_scrape')).toBe('Firecrawl');
    expect(getToolDisplayName('mcp_github_create_issue')).toBe('GitHub');
    expect(getToolDisplayName('mcp_chrome-devtools_take_screenshot')).toBe('Chrome DevTools');
    expect(getToolDisplayName('mcp_obsidian_read_note')).toBe('Obsidian');
  });

  it('未知 server 自动 hyphen/underscore-case 转 Title Case 兜底', () => {
    expect(getToolDisplayName('mcp_my-custom-server_do_thing')).toBe('My Custom Server');
    // 注：mcp_<server>_<tool> 正则 ^mcp_([^_]+)_(.+) 取首段为 server，
    // hyphen-case 的 server 才能完整保留；下划线分隔的 server 会从首个 _ 切断
    expect(getToolDisplayName('mcp_unknownserver_action')).toBe('Unknownserver');
  });

  it('不匹配 mcp_<server>_<tool> 形式时原样返回', () => {
    expect(getToolDisplayName('mcp_invalid')).toBe('mcp_invalid');
  });

  it('旧格式 name === "mcp" 走 displayNames 表，不进 server 解析', () => {
    expect(getToolDisplayName('mcp')).toBe('MCP');
  });

  it('非 MCP 工具不受影响', () => {
    expect(getToolDisplayName('Bash')).toBe('Bash');
    expect(getToolDisplayName('memory_search')).toBe('Recall');
    expect(getToolDisplayName('unknown_tool')).toBe('unknown_tool');
  });
});

describe('formatParams — MCP 工具的 tool 名作副标题', () => {
  it('mcp_<server>_<tool> 时 params 返回 tool 名', () => {
    expect(formatParams(makeToolCall('mcp_exa_search', { query: 'eva' }))).toBe('search');
    expect(formatParams(makeToolCall('mcp_firecrawl_scrape', { url: 'https://x.com' })))
      .toBe('scrape');
    expect(formatParams(makeToolCall('mcp_chrome-devtools_take_screenshot')))
      .toBe('take_screenshot');
  });

  it('不匹配 mcp_<server>_<tool> 形式时回退到 default 分支（first arg）', () => {
    expect(formatParams(makeToolCall('mcp_invalid', { foo: 'bar' }))).toBe('bar');
  });

  it('旧格式 name === "mcp" 仍走原 case "mcp"，输出 server/tool', () => {
    expect(formatParams(makeToolCall('mcp', { server: 'deepwiki', tool: 'read' })))
      .toBe('deepwiki/read');
  });

  it('非 MCP 工具不受影响', () => {
    expect(formatParams(makeToolCall('Bash', { command: 'ls -la' }))).toBe('ls -la');
    expect(formatParams(makeToolCall('Read', { file_path: '/a/b/c.ts' }))).toBe('.../b/c.ts');
  });
});
