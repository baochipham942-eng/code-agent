// ============================================================================
// Tool Status Labels - Per-tool dynamic status text
// Inspired by QoderWork's granular tool status system
// ============================================================================

import type { ToolStatus } from './styles';
import type { ToolCall } from '@shared/contract';

interface StatusLabels {
  preparing: string;   // _streaming === true (args arriving)
  running: string;     // executing
  completed: string;   // success
  error: string;       // failed
}

const TOOL_LABELS: Record<string, StatusLabels> = {
  // File operations
  Bash:     { preparing: '生成命令…', running: '执行中…',   completed: '已执行',   error: '执行失败' },
  Read:     { preparing: '定位文件…', running: '读取中…',   completed: '已读取',   error: '读取失败' },
  Write:    { preparing: '准备内容…', running: '写入中…',   completed: '已创建',   error: '写入失败' },
  Edit:     { preparing: '准备修改…', running: '编辑中…',   completed: '已编辑',   error: '编辑失败' },

  // Search & navigation
  Glob:     { preparing: '准备搜索…', running: '搜索文件…', completed: '搜索完成', error: '搜索失败' },
  Grep:     { preparing: '准备搜索…', running: '搜索内容…', completed: '搜索完成', error: '搜索失败' },
  list_directory: { preparing: '准备浏览…', running: '浏览目录…', completed: '已列出', error: '浏览失败' },

  // Web
  WebSearch: { preparing: '准备搜索…', running: '搜索网络…', completed: '搜索完成', error: '搜索失败' },
  web_fetch: { preparing: '准备抓取…', running: '抓取网页…', completed: '已抓取',   error: '抓取失败' },

  // Agent & planning
  task:         { preparing: '准备任务…', running: '执行任务…',   completed: '任务完成', error: '任务失败' },
  todo_write:   { preparing: '更新待办…', running: '更新待办…',   completed: '已更新',   error: '更新失败' },
  plan_update:  { preparing: '更新计划…', running: '更新计划…',   completed: '已更新',   error: '更新失败' },
  plan_read:    { preparing: '读取计划…', running: '读取计划…',   completed: '已读取',   error: '读取失败' },

  // User interaction
  AskUserQuestion: { preparing: '准备提问…', running: '等待回答…', completed: '已回答', error: '提问失败' },

  // Skills & tools
  skill:       { preparing: '加载技能…', running: '执行技能…',   completed: '技能完成', error: '技能失败' },
  read_pdf:    { preparing: '加载 PDF…', running: '读取 PDF…',   completed: '已读取',   error: '读取失败' },
  ppt_generate: { preparing: '准备生成…', running: '生成 PPT…',  completed: '已生成',   error: '生成失败' },
  image_generate: { preparing: '准备生成…', running: '生成图片…', completed: '已生成',   error: '生成失败' },

  // Memory
  memory_store:  { preparing: '准备存储…', running: '存储记忆…', completed: '已存储', error: '存储失败' },
  memory_search: { preparing: '准备搜索…', running: '搜索记忆…', completed: '已搜索', error: '搜索失败' },
  code_index:    { preparing: '准备索引…', running: '建立索引…', completed: '已索引', error: '索引失败' },

  // Computer use
  screenshot:    { preparing: '准备截图…', running: '截图中…',   completed: '已截图',   error: '截图失败' },
  computer_use:  { preparing: '准备操作…', running: '操作桌面…', completed: '操作完成', error: '操作失败' },
  browser_action: { preparing: '准备操作…', running: '操作浏览器…', completed: '操作完成', error: '操作失败' },

  // Multi-agent
  spawn_agent:   { preparing: '准备启动…', running: '启动 Agent…', completed: '已启动', error: '启动失败' },
  agent_message: { preparing: '准备发送…', running: '发送消息…',   completed: '已发送', error: '发送失败' },

  // Findings
  findings_write: { preparing: '记录发现…', running: '写入发现…', completed: '已记录', error: '记录失败' },
};

const DEFAULT_LABELS: StatusLabels = {
  preparing: '准备中…',
  running: '执行中…',
  completed: '已完成',
  error: '执行失败',
};

/**
 * Get the dynamic status label for a tool call.
 * Uses two-phase pending: _streaming → preparing, !_streaming → running.
 */
export function getToolStatusLabel(
  toolCall: ToolCall,
  status: ToolStatus,
): string {
  const toolName = toolCall.name;

  // MCP tools
  let labels = TOOL_LABELS[toolName];
  if (!labels && (toolName.startsWith('mcp_') || toolName.startsWith('mcp__'))) {
    labels = { preparing: '准备调用…', running: '调用工具…', completed: '调用完成', error: '调用失败' };
  }
  if (!labels) labels = DEFAULT_LABELS;

  switch (status) {
    case 'pending':
      return toolCall._streaming ? labels.preparing : labels.running;
    case 'success':
      return enrichCompletedLabel(toolCall, labels.completed);
    case 'error':
      return labels.error;
    case 'interrupted':
      return '已中断';
  }
}

/**
 * Enrich the completed label with result data when available.
 * E.g., Grep → "找到 12 处匹配", Glob → "找到 5 个文件"
 */
function enrichCompletedLabel(toolCall: ToolCall, defaultLabel: string): string {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return defaultLabel;

  const name = toolCall.name;

  if (name === 'Grep') {
    const match = output.match(/(\d+)\s*match/i);
    if (match) return `找到 ${match[1]} 处匹配`;
    if (output.includes('No matches') || output.includes('0 matches')) return '无匹配';
  }

  if (name === 'Glob') {
    const match = output.match(/(\d+)\s*file/i);
    if (match) return `找到 ${match[1]} 个文件`;
  }

  if (name === 'Read') {
    const match = output.match(/(\d+)\s*lines?\b/i);
    if (match) return `已读取 ${match[1]} 行`;
  }

  return defaultLabel;
}
