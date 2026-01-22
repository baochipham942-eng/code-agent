// ============================================================================
// Tool Summary - 工具调用摘要生成
// ============================================================================

import type { ToolCall } from '@shared/types';

/**
 * 工具图标名称映射（使用 Lucide 图标名称）
 * 实际渲染在 ToolCallDisplay.tsx 中完成
 */
const TOOL_ICON_NAMES: Record<string, string> = {
  // Gen 1 - 基础文件操作
  bash: 'terminal',
  read_file: 'file-text',
  write_file: 'file-plus',
  edit_file: 'file-edit',

  // Gen 2 - 搜索和导航
  glob: 'search',
  grep: 'search-code',
  list_directory: 'folder-open',
  web_search: 'globe',

  // Gen 3 - 子代理和规划
  task: 'bot',
  todo_write: 'list-todo',
  ask_user_question: 'message-circle-question',

  // Gen 4 - 技能系统和网络
  skill: 'sparkles',
  web_fetch: 'globe',
  mcp: 'plug',

  // Gen 5 - RAG 和长期记忆
  memory_store: 'database',
  memory_search: 'search',
  code_index: 'file-code',

  // Gen 6 - Computer Use
  screenshot: 'camera',
  computer_use: 'monitor',
  browser_action: 'chrome',

  // Gen 7 - 多代理协同
  spawn_agent: 'users',
  agent_message: 'message-square',
  workflow_orchestrate: 'git-branch',

  // Gen 8 - 自我进化
  strategy_optimize: 'target',
  tool_create: 'wrench',
  self_evaluate: 'scan-eye',

  // Gen 3 - Planning 工具
  plan_update: 'clipboard-list',
  plan_read: 'clipboard',
  findings_write: 'file-text',
};

/**
 * 获取工具图标名称（返回 Lucide 图标名称）
 */
export function getToolIconName(toolName: string): string {
  // 检查是否为 MCP 工具
  if (toolName.startsWith('mcp_') || toolName === 'mcp') {
    return 'plug';
  }
  return TOOL_ICON_NAMES[toolName] || 'wrench';
}

/**
 * 获取工具图标（保留兼容性，返回 emoji）
 * @deprecated 请使用 getToolIconName 配合 Lucide 图标
 */
export function getToolIcon(toolName: string): string {
  // 保留 emoji 映射用于兼容
  const emojiMap: Record<string, string> = {
    bash: '💻',
    read_file: '📖',
    write_file: '✍️',
    edit_file: '✏️',
    glob: '🔍',
    grep: '🔎',
    list_directory: '📁',
    task: '🤖',
    todo_write: '📝',
    ask_user_question: '❓',
    skill: '⚡',
    web_fetch: '🌐',
    web_search: '🔍',
    mcp: '🔌',
    memory_store: '💾',
    memory_search: '🧠',
    code_index: '📚',
  };

  if (toolName.startsWith('mcp_') || toolName === 'mcp') {
    return '🔌';
  }
  return emojiMap[toolName] || '🔧';
}

/**
 * 生成工具调用摘要
 */
export function summarizeToolCall(toolCall: ToolCall): string {
  const { name, arguments: args } = toolCall;

  // 根据工具类型生成不同的摘要
  switch (name) {
    // Gen 1 工具
    case 'bash': {
      const command = (args?.command as string) || '';
      const shortCommand = command.length > 60 ? command.slice(0, 57) + '...' : command;
      return `执行命令: ${shortCommand}`;
    }

    case 'read_file': {
      let filePath = (args?.file_path as string) || '';
      // 清理可能混入的参数（AI 可能把 offset/limit 写到 file_path 里）
      if (filePath.includes(' offset=') || filePath.includes(' limit=')) {
        filePath = filePath.split(' ')[0];
      }
      const fileName = filePath.split('/').pop() || filePath;
      const offset = args?.offset as number;
      const limit = args?.limit as number;
      if (offset && offset > 1) {
        return `读取文件: ${fileName} (从第 ${offset} 行)`;
      }
      return `读取文件: ${fileName}`;
    }

    case 'write_file': {
      const filePath = (args?.file_path as string) || '';
      const fileName = filePath.split('/').pop() || filePath;
      return `创建文件: ${fileName}`;
    }

    case 'edit_file': {
      const filePath = (args?.file_path as string) || '';
      const fileName = filePath.split('/').pop() || filePath;
      // If tool has result and failed, show failure message instead of line diff
      if (toolCall.result && !toolCall.result.success) {
        return `编辑文件失败: ${fileName}`;
      }
      const oldStr = (args?.old_string as string) || '';
      const newStr = (args?.new_string as string) || '';
      const oldLines = oldStr.split('\n').length;
      const newLines = newStr.split('\n').length;
      const diff = newLines - oldLines;
      const diffStr = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '±0';
      return `编辑文件: ${fileName} (${diffStr} 行)`;
    }

    // Gen 2 工具
    case 'glob': {
      const pattern = (args?.pattern as string) || '*';
      return `搜索文件: ${pattern}`;
    }

    case 'grep': {
      const pattern = (args?.pattern as string) || '';
      const path = (args?.path as string) || '.';
      return `搜索内容: "${pattern}" in ${path}`;
    }

    case 'list_directory': {
      const path = (args?.path as string) || '.';
      return `列出目录: ${path}`;
    }

    // Gen 3 工具
    case 'task': {
      const description = (args?.description as string) || '';
      const shortDesc = description.length > 40 ? description.slice(0, 37) + '...' : description;
      return `委托任务: ${shortDesc}`;
    }

    case 'todo_write': {
      const todos = args?.todos as Array<{ content: string; status: string }>;
      if (todos && Array.isArray(todos)) {
        const completed = todos.filter((t) => t.status === 'completed').length;
        const total = todos.length;
        return `更新待办: ${completed}/${total} 完成`;
      }
      return '更新待办列表';
    }

    case 'ask_user_question': {
      const question = (args?.question as string) || '';
      const shortQ = question.length > 40 ? question.slice(0, 37) + '...' : question;
      return `询问用户: ${shortQ}`;
    }

    // Gen 4 工具
    case 'skill': {
      const skillName = (args?.skill as string) || '';
      return `调用技能: ${skillName}`;
    }

    case 'web_fetch': {
      const url = (args?.url as string) || '';
      try {
        const urlObj = new URL(url);
        return `获取网页: ${urlObj.hostname}`;
      } catch {
        return `获取网页: ${url.slice(0, 30)}...`;
      }
    }

    // Gen 5 工具
    case 'memory_store': {
      const key = (args?.key as string) || '';
      return `存储记忆: ${key}`;
    }

    case 'memory_search': {
      const query = (args?.query as string) || '';
      const shortQuery = query.length > 30 ? query.slice(0, 27) + '...' : query;
      return `搜索记忆: ${shortQuery}`;
    }

    case 'code_index': {
      const path = (args?.path as string) || '.';
      return `索引代码: ${path}`;
    }

    // Gen 6 工具
    case 'screenshot': {
      return '截取屏幕';
    }

    case 'computer_use': {
      const action = (args?.action as string) || '';
      return `计算机操作: ${action}`;
    }

    case 'browser_action': {
      const action = (args?.action as string) || '';
      const url = (args?.url as string) || '';
      if (url) {
        try {
          const urlObj = new URL(url);
          return `浏览器${action}: ${urlObj.hostname}`;
        } catch {
          return `浏览器${action}`;
        }
      }
      return `浏览器操作: ${action}`;
    }

    // Gen 7 工具
    case 'spawn_agent': {
      const agentType = (args?.type as string) || '';
      return `创建代理: ${agentType}`;
    }

    case 'agent_message': {
      const targetAgent = (args?.target as string) || '';
      return `发送消息给: ${targetAgent}`;
    }

    case 'workflow_orchestrate': {
      const workflow = (args?.workflow as string) || '';
      return `编排工作流: ${workflow}`;
    }

    // Gen 8 工具
    case 'strategy_optimize': {
      return '优化策略';
    }

    case 'tool_create': {
      const toolName = (args?.name as string) || '';
      return `创建工具: ${toolName}`;
    }

    case 'self_evaluate': {
      return '自我评估';
    }

    // Gen 3 Planning 工具
    case 'plan_update': {
      const stepContent = (args?.stepContent as string) || '';
      const status = (args?.status as string) || '';
      const statusIcon = {
        pending: '○',
        in_progress: '◐',
        completed: '●',
        skipped: '⊘',
      }[status] || '○';
      const shortStep = stepContent.length > 35 ? stepContent.slice(0, 32) + '...' : stepContent;
      return `${statusIcon} ${shortStep}`;
    }

    case 'plan_read': {
      return '读取计划';
    }

    case 'findings_write': {
      const title = (args?.title as string) || '';
      return `记录发现: ${title}`;
    }

    // MCP 工具（通过 mcp 工具调用）
    case 'mcp': {
      const server = (args?.server as string) || '';
      const tool = (args?.tool as string) || '';
      const mcpArgs = args?.arguments as Record<string, unknown> | undefined;

      // 根据服务器和工具生成友好摘要
      if (server === 'deepwiki') {
        const repoName = (mcpArgs?.repoName as string) || '';
        if (tool === 'read_wiki_structure') {
          return `查看 ${repoName} 项目结构`;
        } else if (tool === 'read_wiki_contents') {
          const topic = (mcpArgs?.topic as string) || '';
          return topic ? `阅读 ${repoName} - ${topic}` : `阅读 ${repoName} 文档`;
        } else if (tool === 'ask_question') {
          return `询问 ${repoName} 相关问题`;
        }
        return `DeepWiki: ${tool}`;
      }

      // 其他 MCP 服务器
      if (tool) {
        return `${server}: ${tool}`;
      }
      return `连接 ${server} 服务`;
    }

    // MCP 工具（旧格式，mcp_ 前缀）
    default: {
      if (name.startsWith('mcp_')) {
        // 解析 MCP 工具名: mcp_<serverName>_<toolName>
        const parts = name.match(/^mcp_([^_]+)_(.+)$/);
        if (parts) {
          const [, serverName, toolName] = parts;
          return `${serverName}: ${toolName}`;
        }
      }
      // 通用格式 - 简化显示
      return name;
    }
  }
}

/**
 * 获取工具调用的状态文本
 */
export function getToolStatusText(toolCall: ToolCall): string {
  if (!toolCall.result) {
    return '执行中...';
  }

  if (toolCall.result.success) {
    const duration = toolCall.result.duration;
    if (duration) {
      if (duration < 1000) {
        return `完成 (${duration}ms)`;
      }
      return `完成 (${(duration / 1000).toFixed(1)}s)`;
    }
    return '完成';
  }

  return '失败';
}

/**
 * 获取工具调用的状态颜色类名
 */
export function getToolStatusClass(toolCall: ToolCall): string {
  if (!toolCall.result) {
    return 'text-yellow-400'; // 执行中
  }

  if (toolCall.result.success) {
    return 'text-emerald-400'; // 成功
  }

  return 'text-rose-400'; // 失败
}
