// ============================================================================
// toolSummary.test.ts - 工具调用摘要生成测试
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  getToolIconName,
  getToolIcon,
  summarizeToolCall,
  getToolStatusText,
  getToolStatusClass,
} from '../../../src/renderer/utils/toolSummary';
import type { ToolCall } from '../../../src/shared/types/tool';

function makeToolCall(overrides: Partial<ToolCall> & Pick<ToolCall, 'name'>): ToolCall {
  return {
    id: 'tc-1',
    arguments: {},
    ...overrides,
  };
}

// ============================================================================
// getToolIconName
// ============================================================================

describe('getToolIconName', () => {
  it('should return correct icon for known tools', () => {
    expect(getToolIconName('Bash')).toBe('terminal');
    expect(getToolIconName('Read')).toBe('file-text');
    expect(getToolIconName('Write')).toBe('file-plus');
    expect(getToolIconName('Edit')).toBe('file-edit');
    expect(getToolIconName('Glob')).toBe('search');
    expect(getToolIconName('Grep')).toBe('search-code');
  });

  it('should return plug icon for MCP tools', () => {
    expect(getToolIconName('mcp_deepwiki_read')).toBe('plug');
    expect(getToolIconName('mcp')).toBe('plug');
  });

  it('should return wrench for unknown tools', () => {
    expect(getToolIconName('unknown_tool')).toBe('wrench');
  });
});

// ============================================================================
// getToolIcon (deprecated emoji version)
// ============================================================================

describe('getToolIcon', () => {
  it('should return emoji for known tools', () => {
    expect(getToolIcon('Bash')).toBe('💻');
    expect(getToolIcon('Read')).toBe('📖');
  });

  it('should return plug emoji for MCP tools', () => {
    expect(getToolIcon('mcp_server_tool')).toBe('🔌');
    expect(getToolIcon('mcp')).toBe('🔌');
  });

  it('should return wrench emoji for unknown tools', () => {
    expect(getToolIcon('anything_else')).toBe('🔧');
  });
});

// ============================================================================
// summarizeToolCall
// ============================================================================

describe('summarizeToolCall', () => {
  it('should summarize Bash tool', () => {
    const tc = makeToolCall({ name: 'Bash', arguments: { command: 'ls -la' } });
    expect(summarizeToolCall(tc)).toBe('执行命令: ls -la');
  });

  it('should truncate long Bash commands', () => {
    const longCmd = 'a'.repeat(100);
    const tc = makeToolCall({ name: 'Bash', arguments: { command: longCmd } });
    const result = summarizeToolCall(tc);
    expect(result.length).toBeLessThan(80);
    expect(result).toContain('...');
  });

  it('should summarize Read tool with filename', () => {
    const tc = makeToolCall({ name: 'Read', arguments: { file_path: '/src/main/index.ts' } });
    expect(summarizeToolCall(tc)).toBe('读取文件: index.ts');
  });

  it('should summarize Read with offset', () => {
    const tc = makeToolCall({ name: 'Read', arguments: { file_path: '/a/b.ts', offset: 50 } });
    expect(summarizeToolCall(tc)).toContain('从第 50 行');
  });

  it('should clean file_path with mixed-in params in Read', () => {
    const tc = makeToolCall({ name: 'Read', arguments: { file_path: '/a/b.ts offset=10 limit=20' } });
    expect(summarizeToolCall(tc)).toContain('b.ts');
  });

  it('should summarize Write tool', () => {
    const tc = makeToolCall({ name: 'Write', arguments: { file_path: '/src/new.ts' } });
    expect(summarizeToolCall(tc)).toBe('创建文件: new.ts');
  });

  it('should summarize Edit tool with line diff', () => {
    const tc = makeToolCall({
      name: 'Edit',
      arguments: {
        file_path: '/src/app.ts',
        old_string: 'line1\nline2',
        new_string: 'line1\nline2\nline3\nline4',
      },
    });
    const result = summarizeToolCall(tc);
    expect(result).toContain('app.ts');
    expect(result).toContain('+2');
  });

  it('should show failure message for failed Edit', () => {
    const tc = makeToolCall({
      name: 'Edit',
      arguments: { file_path: '/src/app.ts', old_string: 'x', new_string: 'y' },
      result: { toolCallId: 'tc-1', success: false, error: 'not found' },
    });
    expect(summarizeToolCall(tc)).toContain('编辑文件失败');
  });

  it('should summarize Glob tool', () => {
    const tc = makeToolCall({ name: 'Glob', arguments: { pattern: '**/*.ts' } });
    expect(summarizeToolCall(tc)).toBe('搜索文件: **/*.ts');
  });

  it('should summarize Grep tool', () => {
    const tc = makeToolCall({ name: 'Grep', arguments: { pattern: 'TODO', path: 'src/' } });
    expect(summarizeToolCall(tc)).toContain('TODO');
    expect(summarizeToolCall(tc)).toContain('src/');
  });

  it('should summarize task tool', () => {
    const tc = makeToolCall({ name: 'task', arguments: { description: 'Fix the bug' } });
    expect(summarizeToolCall(tc)).toContain('Fix the bug');
  });

  it('should summarize web_fetch with valid URL', () => {
    const tc = makeToolCall({ name: 'web_fetch', arguments: { url: 'https://example.com/page' } });
    expect(summarizeToolCall(tc)).toContain('example.com');
  });

  it('should summarize web_fetch with invalid URL', () => {
    const tc = makeToolCall({ name: 'web_fetch', arguments: { url: 'not-a-url' } });
    expect(summarizeToolCall(tc)).toContain('not-a-url');
  });

  it('should summarize MCP tool (mcp name)', () => {
    const tc = makeToolCall({
      name: 'mcp',
      arguments: { server: 'deepwiki', tool: 'read_wiki_structure', arguments: { repoName: 'myrepo' } },
    });
    expect(summarizeToolCall(tc)).toContain('myrepo');
  });

  it('should summarize MCP tool (mcp_ prefix)', () => {
    const tc = makeToolCall({ name: 'mcp_github_create_issue', arguments: {} });
    expect(summarizeToolCall(tc)).toContain('github');
    expect(summarizeToolCall(tc)).toContain('create_issue');
  });

  it('should return tool name for unknown tools', () => {
    const tc = makeToolCall({ name: 'custom_tool', arguments: {} });
    expect(summarizeToolCall(tc)).toBe('custom_tool');
  });

  it('should summarize screenshot tool', () => {
    const tc = makeToolCall({ name: 'screenshot', arguments: {} });
    expect(summarizeToolCall(tc)).toBe('截取屏幕');
  });

  it('should summarize plan_update with status icon', () => {
    const tc = makeToolCall({
      name: 'plan_update',
      arguments: { stepContent: 'Review code', status: 'completed' },
    });
    expect(summarizeToolCall(tc)).toContain('●');
    expect(summarizeToolCall(tc)).toContain('Review code');
  });
});

// ============================================================================
// getToolStatusText
// ============================================================================

describe('getToolStatusText', () => {
  it('should show "执行中..." for pending tool', () => {
    const tc = makeToolCall({ name: 'Bash' });
    expect(getToolStatusText(tc)).toBe('执行中...');
  });

  it('should show "完成" for successful tool without duration', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc-1', success: true },
    });
    expect(getToolStatusText(tc)).toBe('完成');
  });

  it('should show duration in ms for fast tools', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc-1', success: true, duration: 150 },
    });
    expect(getToolStatusText(tc)).toBe('完成 (150ms)');
  });

  it('should show duration in seconds for slow tools', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc-1', success: true, duration: 3500 },
    });
    expect(getToolStatusText(tc)).toBe('完成 (3.5s)');
  });

  it('should show "失败" for failed tools', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc-1', success: false, error: 'timeout' },
    });
    expect(getToolStatusText(tc)).toBe('失败');
  });
});

// ============================================================================
// getToolStatusClass
// ============================================================================

describe('getToolStatusClass', () => {
  it('should return yellow for pending', () => {
    const tc = makeToolCall({ name: 'Bash' });
    expect(getToolStatusClass(tc)).toContain('yellow');
  });

  it('should return emerald for success', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc-1', success: true },
    });
    expect(getToolStatusClass(tc)).toContain('emerald');
  });

  it('should return rose for failure', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc-1', success: false },
    });
    expect(getToolStatusClass(tc)).toContain('rose');
  });
});
