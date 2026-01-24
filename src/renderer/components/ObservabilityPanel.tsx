// ============================================================================
// ObservabilityPanel - AI Execution Observability (Advanced Mode)
// 手风琴展示方式，与代际工具集挂钩
// ============================================================================

import React, { useState, useMemo } from 'react';
import { UI } from '@shared/constants';
import {
  Target,
  Terminal,
  Wrench,
  Brain,
  Users,
  ChevronRight,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  FileText,
  FileCode,
  Search,
  Edit3,
  Globe,
  Sparkles,
  ListTodo,
  HelpCircle,
  X,
  Plug,
  Server,
  Database,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import type { ToolCall } from '@shared/types';
import { ContextHealthPanel } from './ContextHealthPanel';

// 事件类型 - 7个核心分类（Gen4 新增 MCP 和 Skill）
type EventCategory = 'plan' | 'bash' | 'tools' | 'memory' | 'agent' | 'mcp' | 'skill';

// 可观测事件
interface ObservableEvent {
  id: string;
  category: EventCategory;
  name: string;
  summary: string;
  timestamp: number;
  duration?: number;
  status: 'pending' | 'success' | 'error';
  details?: Record<string, unknown>;
}

// 分类配置 - 6个分类
const categoryConfig: Record<EventCategory, {
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  // 该分类包含的工具列表
  tools: string[];
  // 该分类首次出现的代际
  minGeneration: number;
}> = {
  bash: {
    label: 'Bash',
    icon: <Terminal className="w-4 h-4" />,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-500/30',
    tools: ['bash'],
    minGeneration: 1,
  },
  tools: {
    label: 'Tools',
    icon: <Wrench className="w-4 h-4" />,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30',
    tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'web_fetch'],
    minGeneration: 1,
  },
  plan: {
    label: 'Plan',
    icon: <Target className="w-4 h-4" />,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/30',
    tools: ['todo_write'],
    minGeneration: 3,
  },
  agent: {
    label: 'Agent',
    icon: <Users className="w-4 h-4" />,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-orange-500/30',
    tools: ['task', 'ask_user_question', 'spawn_agent', 'agent_message', 'workflow_orchestrate'],
    minGeneration: 3,
  },
  mcp: {
    label: 'MCP',
    icon: <Plug className="w-4 h-4" />,
    color: 'text-pink-400',
    bgColor: 'bg-pink-500/10',
    borderColor: 'border-pink-500/30',
    tools: ['mcp', 'mcp_list_tools', 'mcp_list_resources', 'mcp_read_resource', 'mcp_get_status'],
    minGeneration: 4,
  },
  skill: {
    label: 'Skill',
    icon: <Sparkles className="w-4 h-4" />,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30',
    tools: ['skill'],
    minGeneration: 4,
  },
  memory: {
    label: 'Memory',
    icon: <Brain className="w-4 h-4" />,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10',
    borderColor: 'border-cyan-500/30',
    tools: ['memory_store', 'memory_search', 'code_index'],
    minGeneration: 5,
  },
};

// 工具到分类的映射
const toolCategoryMap: Record<string, EventCategory> = {
  // Bash
  bash: 'bash',

  // File Tools
  read_file: 'tools',
  write_file: 'tools',
  edit_file: 'tools',
  glob: 'tools',
  grep: 'tools',
  list_directory: 'tools',

  // Planning Tools
  todo_write: 'plan',

  // Agent Tools (Gen3+)
  task: 'agent',
  ask_user_question: 'agent',
  // Gen7 Multi-Agent Tools
  spawn_agent: 'agent',
  agent_message: 'agent',
  workflow_orchestrate: 'agent',

  // Skill
  skill: 'skill',

  // Web
  web_fetch: 'tools',

  // MCP Tools (Gen 4+)
  mcp: 'mcp',
  mcp_list_tools: 'mcp',
  mcp_list_resources: 'mcp',
  mcp_read_resource: 'mcp',
  mcp_get_status: 'mcp',

  // Memory Tools
  memory_store: 'memory',
  memory_search: 'memory',
  code_index: 'memory',
};

// 从工具调用生成摘要
function getToolSummary(toolCall: ToolCall): string {
  const args = toolCall.arguments || {};

  switch (toolCall.name) {
    case 'bash': {
      const cmd = (args.command as string) || '';
      return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
    }
    case 'read_file':
      return `读取 ${(args.file_path as string)?.split('/').pop() || '文件'}`;
    case 'write_file':
      return `写入 ${(args.file_path as string)?.split('/').pop() || '文件'}`;
    case 'edit_file':
      return `编辑 ${(args.file_path as string)?.split('/').pop() || '文件'}`;
    case 'glob':
      return `搜索 ${args.pattern || '文件'}`;
    case 'grep':
      return `搜索 "${args.pattern || '内容'}"`;
    case 'list_directory':
      return `列出 ${(args.path as string)?.split('/').pop() || '目录'}`;
    case 'todo_write': {
      const todos = args.todos as Array<{ content: string }> | undefined;
      return todos ? `更新 ${todos.length} 个待办` : '更新待办事项';
    }
    case 'task':
      return (args.description as string) || '执行子任务';
    case 'ask_user_question':
      return '询问用户';
    case 'skill':
      return `技能: ${args.skill || '未知'}`;
    case 'web_fetch':
      return `获取 ${args.url || '网页'}`;
    case 'memory_store': {
      const category = args.category as string;
      const content = args.content as string;
      const preview = content ? (content.length > 30 ? content.slice(0, 30) + '...' : content) : '';
      return `存储 [${category || '记忆'}] ${preview}`;
    }
    case 'memory_search': {
      const query = args.query as string;
      const source = args.source as string;
      const sourceLabel = source && source !== 'all' ? ` (${source})` : '';
      return `搜索${sourceLabel}: ${query || ''}`;
    }
    case 'code_index': {
      const action = args.action as string;
      if (action === 'index') {
        const pattern = args.pattern as string;
        return `索引代码: ${pattern || '**/*.{ts,tsx,...}'}`;
      }
      if (action === 'search') {
        const query = args.query as string;
        return `搜索代码: ${query || ''}`;
      }
      if (action === 'status') {
        return '查询索引状态';
      }
      return `code_index: ${action}`;
    }
    // MCP Tools
    case 'mcp':
      return `MCP: ${args.server || '?'}/${args.tool || '?'}`;
    case 'mcp_list_tools':
      return args.server ? `列出 ${args.server} 工具` : '列出 MCP 工具';
    case 'mcp_list_resources':
      return args.server ? `列出 ${args.server} 资源` : '列出 MCP 资源';
    case 'mcp_read_resource':
      return `读取资源: ${(args.uri as string)?.split('/').pop() || '?'}`;
    case 'mcp_get_status':
      return '获取 MCP 状态';
    // Gen7 Multi-Agent Tools
    case 'spawn_agent': {
      const role = args.role as string;
      const parallel = args.parallel as boolean;
      const agents = args.agents as Array<{ role: string }> | undefined;
      if (parallel && agents) {
        return `并行创建 ${agents.length} 个 Agent`;
      }
      return `创建 ${role || '未知'} Agent`;
    }
    case 'agent_message': {
      const action = args.action as string;
      const agentId = args.agentId as string;
      if (action === 'list') return '列出所有 Agent';
      if (action === 'status') return `查询 ${agentId || 'Agent'} 状态`;
      if (action === 'result') return `获取 ${agentId || 'Agent'} 结果`;
      if (action === 'cancel') return `取消 ${agentId || 'Agent'}`;
      return 'Agent 消息';
    }
    case 'workflow_orchestrate': {
      const workflow = args.workflow as string;
      return workflow === 'custom' ? '自定义工作流' : `工作流: ${workflow || '未知'}`;
    }
    default:
      return toolCall.name;
  }
}

// 获取工具图标
function getToolIcon(name: string): React.ReactNode {
  const iconMap: Record<string, React.ReactNode> = {
    bash: <Terminal className="w-3 h-3" />,
    read_file: <FileText className="w-3 h-3" />,
    write_file: <FileText className="w-3 h-3" />,
    edit_file: <Edit3 className="w-3 h-3" />,
    glob: <Search className="w-3 h-3" />,
    grep: <Search className="w-3 h-3" />,
    list_directory: <Search className="w-3 h-3" />,
    todo_write: <ListTodo className="w-3 h-3" />,
    task: <Users className="w-3 h-3" />,
    ask_user_question: <HelpCircle className="w-3 h-3" />,
    skill: <Sparkles className="w-3 h-3" />,
    web_fetch: <Globe className="w-3 h-3" />,
    memory_store: <Brain className="w-3 h-3" />,
    memory_search: <Brain className="w-3 h-3" />,
    code_index: <FileCode className="w-3 h-3" />,
    // MCP Tools
    mcp: <Plug className="w-3 h-3" />,
    mcp_list_tools: <Server className="w-3 h-3" />,
    mcp_list_resources: <Database className="w-3 h-3" />,
    mcp_read_resource: <Database className="w-3 h-3" />,
    mcp_get_status: <Server className="w-3 h-3" />,
    // Gen7 Multi-Agent Tools
    spawn_agent: <Users className="w-3 h-3" />,
    agent_message: <Users className="w-3 h-3" />,
    workflow_orchestrate: <Users className="w-3 h-3" />,
  };
  return iconMap[name] || <Wrench className="w-3 h-3" />;
}

// 格式化 Memory 工具详情
function formatMemoryDetails(event: ObservableEvent): {
  showCustom: boolean;
  customContent?: React.ReactNode;
} {
  if (event.category !== 'memory') {
    return { showCustom: false };
  }

  const args = event.details?.arguments as Record<string, unknown> | undefined;
  const result = event.details?.result as { output?: string; error?: string } | undefined;

  // memory_store: 显示存储的内容和分类
  if (event.name === 'memory_store' && args) {
    const category = args.category as string;
    const content = args.content as string;
    const key = args.key as string;
    const confidence = args.confidence as number;

    return {
      showCustom: true,
      customContent: (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <span className="px-2 py-0.5 text-xs rounded bg-cyan-500/20 text-cyan-300">
              {category}
            </span>
            {key && (
              <span className="px-2 py-0.5 text-xs rounded bg-zinc-700 text-zinc-300">
                key: {key}
              </span>
            )}
            {confidence !== undefined && confidence < 1 && (
              <span className="px-2 py-0.5 text-xs rounded bg-amber-500/20 text-amber-300">
                {Math.round(confidence * 100)}% 置信
              </span>
            )}
          </div>
          <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-x-auto max-h-20 whitespace-pre-wrap">
            {content}
          </pre>
          {event.status === 'success' && (
            <div className="text-xs text-emerald-400 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />
              已存储到记忆库
            </div>
          )}
        </div>
      ),
    };
  }

  // memory_search: 显示搜索结果摘要
  if (event.name === 'memory_search' && result?.output) {
    const output = result.output;
    // 解析搜索结果数量
    const countMatch = output.match(/Found (\d+) relevant/);
    const resultCount = countMatch ? parseInt(countMatch[1]) : 0;

    return {
      showCustom: true,
      customContent: (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 text-xs rounded bg-cyan-500/20 text-cyan-300">
              {resultCount} 条结果
            </span>
            {args?.category ? (
              <span className="px-2 py-0.5 text-xs rounded bg-zinc-700 text-zinc-300">
                {String(args.category)}
              </span>
            ) : null}
            {args?.source && args.source !== 'all' ? (
              <span className="px-2 py-0.5 text-xs rounded bg-purple-500/20 text-purple-300">
                {String(args.source)}
              </span>
            ) : null}
          </div>
          <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap">
            {output.slice(0, 500)}{output.length > 500 ? '...' : ''}
          </pre>
        </div>
      ),
    };
  }

  // code_index: 显示索引/搜索状态
  if (event.name === 'code_index' && args) {
    const action = args.action as string;

    if (action === 'index') {
      const pattern = args.pattern as string;
      // 解析索引数量
      const indexMatch = result?.output?.match(/Indexed (\d+) of (\d+)/);
      const indexed = indexMatch ? parseInt(indexMatch[1]) : 0;
      const total = indexMatch ? parseInt(indexMatch[2]) : 0;

      return {
        showCustom: true,
        customContent: (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-xs rounded bg-blue-500/20 text-blue-300">
                索引
              </span>
              <span className="text-xs text-zinc-400">
                {pattern || '**/*.{ts,tsx,...}'}
              </span>
            </div>
            {event.status === 'success' && indexMatch && (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${total > 0 ? (indexed / total) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-xs text-zinc-400">
                  {indexed}/{total}
                </span>
              </div>
            )}
          </div>
        ),
      };
    }

    if (action === 'search') {
      const query = args.query as string;
      const countMatch = result?.output?.match(/Found (\d+) code matches/);
      const resultCount = countMatch ? parseInt(countMatch[1]) : 0;

      return {
        showCustom: true,
        customContent: (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-xs rounded bg-purple-500/20 text-purple-300">
                代码搜索
              </span>
              <span className="text-xs text-zinc-400">
                "{query}"
              </span>
              {event.status === 'success' && (
                <span className="px-2 py-0.5 text-xs rounded bg-cyan-500/20 text-cyan-300">
                  {resultCount} 条
                </span>
              )}
            </div>
            {result?.output && (
              <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap">
                {result.output.slice(0, 500)}{result.output.length > 500 ? '...' : ''}
              </pre>
            )}
          </div>
        ),
      };
    }

    if (action === 'status') {
      return {
        showCustom: true,
        customContent: (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-xs rounded bg-zinc-700 text-zinc-300">
                索引状态
              </span>
            </div>
            {result?.output && (
              <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-x-auto max-h-24 whitespace-pre-wrap">
                {result.output}
              </pre>
            )}
          </div>
        ),
      };
    }
  }

  return { showCustom: false };
}

// 分类顺序 - 按任务执行的常规流程
// Plan(规划) → Bash(执行) → Agent(协作) → Tools(工具) → Skill(技能) → MCP(外部服务) → Memory(记忆)
const categoryOrder: EventCategory[] = ['plan', 'bash', 'agent', 'tools', 'skill', 'mcp', 'memory'];

export const ObservabilityPanel: React.FC = () => {
  const { currentGeneration, contextHealth, contextHealthCollapsed, setContextHealthCollapsed } = useAppStore();
  const { messages } = useSessionStore();
  const [expandedCategories, setExpandedCategories] = useState<Set<EventCategory>>(new Set(['plan', 'bash']));
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  // 获取当前代际数字
  const currentGenNumber = parseInt(currentGeneration.id.replace('gen', ''));

  // 根据代际过滤可用分类
  const availableCategories = useMemo(() => {
    return categoryOrder.filter(cat => categoryConfig[cat].minGeneration <= currentGenNumber);
  }, [currentGenNumber]);

  // 从消息中提取可观测事件
  const events = useMemo(() => {
    const allEvents: ObservableEvent[] = [];

    messages.forEach((message) => {
      if (message.role === 'assistant' && message.toolCalls) {
        message.toolCalls.forEach((toolCall) => {
          const category = toolCategoryMap[toolCall.name] || 'tools';
          const status = !toolCall.result
            ? 'pending'
            : toolCall.result.success
              ? 'success'
              : 'error';

          allEvents.push({
            id: toolCall.id,
            category,
            name: toolCall.name,
            summary: getToolSummary(toolCall),
            timestamp: message.timestamp,
            duration: toolCall.result?.duration,
            status,
            details: {
              arguments: toolCall.arguments,
              result: toolCall.result,
            },
          });
        });
      }
    });

    // 按时间倒序
    return allEvents.sort((a, b) => b.timestamp - a.timestamp);
  }, [messages]);

  // 按分类分组事件
  const eventsByCategory = useMemo(() => {
    const grouped: Record<EventCategory, ObservableEvent[]> = {
      bash: [],
      tools: [],
      plan: [],
      agent: [],
      skill: [],
      mcp: [],
      memory: [],
    };

    events.forEach(event => {
      if (grouped[event.category]) {
        grouped[event.category].push(event);
      }
    });

    return grouped;
  }, [events]);

  // 统计信息
  const stats = useMemo(() => {
    return {
      total: events.length,
      success: events.filter(e => e.status === 'success').length,
      error: events.filter(e => e.status === 'error').length,
      pending: events.filter(e => e.status === 'pending').length,
    };
  }, [events]);

  const toggleCategory = (cat: EventCategory) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const toggleEvent = (id: string) => {
    setExpandedEvents(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // 如果当前代际没有可观测的分类，不渲染面板
  if (availableCategories.length === 0) {
    return null;
  }

  const { setShowPlanningPanel } = useAppStore();

  return (
    <div className="w-80 flex flex-col border-l border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">执行追踪</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Gen{currentGenNumber} · {availableCategories.length} 个观测维度
          </p>
        </div>
        <button
          onClick={() => setShowPlanningPanel(false)}
          className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Context Health Panel - 上下文健康度指示器 */}
      <ContextHealthPanel
        health={contextHealth}
        collapsed={contextHealthCollapsed}
        onToggle={() => setContextHealthCollapsed(!contextHealthCollapsed)}
      />

      {/* Accordion Categories */}
      <div className="flex-1 overflow-y-auto">
        {availableCategories.map(cat => {
          const config = categoryConfig[cat];
          const categoryEvents = eventsByCategory[cat];
          const isExpanded = expandedCategories.has(cat);
          const hasEvents = categoryEvents.length > 0;

          return (
            <div key={cat} className="border-b border-zinc-800/50">
              {/* Category Header (Accordion Toggle) */}
              <button
                onClick={() => toggleCategory(cat)}
                className={`w-full px-4 py-3 flex items-center gap-3 hover:bg-zinc-800/30 transition-colors ${
                  isExpanded ? 'bg-zinc-800/20' : ''
                }`}
              >
                {/* Expand Icon */}
                <div className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                  <ChevronRight className="w-4 h-4 text-zinc-500" />
                </div>

                {/* Category Icon */}
                <div className={`p-1.5 rounded-lg ${config.bgColor} ${config.color}`}>
                  {config.icon}
                </div>

                {/* Category Name */}
                <span className={`flex-1 text-left text-sm font-medium ${config.color}`}>
                  {config.label}
                </span>

                {/* Event Count */}
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  hasEvents ? config.bgColor + ' ' + config.color : 'bg-zinc-800 text-zinc-500'
                }`}>
                  {categoryEvents.length}
                </span>
              </button>

              {/* Category Events (Collapsed Content) */}
              {isExpanded && (
                <div className="bg-zinc-900/30">
                  {!hasEvents ? (
                    <div className="px-4 py-6 text-center">
                      <p className="text-xs text-zinc-500">暂无 {config.label} 记录</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-800/30">
                      {categoryEvents.map(event => {
                        const isEventExpanded = expandedEvents.has(event.id);

                        return (
                          <div key={event.id} className="animate-fadeIn">
                            {/* Event Header */}
                            <button
                              onClick={() => toggleEvent(event.id)}
                              className="w-full px-4 py-2.5 flex items-start gap-2 hover:bg-zinc-800/20 transition-colors text-left"
                            >
                              {/* Expand Icon */}
                              <div className={`mt-0.5 transition-transform ${isEventExpanded ? 'rotate-90' : ''}`}>
                                <ChevronRight className="w-3 h-3 text-zinc-600" />
                              </div>

                              {/* Tool Icon */}
                              <div className={`p-1 rounded ${config.bgColor} ${config.color}`}>
                                {getToolIcon(event.name)}
                              </div>

                              {/* Content */}
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-zinc-300 truncate">
                                  {event.summary}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-xs text-zinc-500">{event.name}</span>
                                  {event.duration && (
                                    <span className="text-xs text-zinc-600 flex items-center gap-0.5">
                                      <Clock className="w-2.5 h-2.5" />
                                      {event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Status */}
                              <div className="mt-0.5">
                                {event.status === 'pending' && (
                                  <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                                )}
                                {event.status === 'success' && (
                                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                                )}
                                {event.status === 'error' && (
                                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                                )}
                              </div>
                            </button>

                            {/* Event Details */}
                            {isEventExpanded && event.details && (
                              <div className="px-4 pb-3 pl-10 animate-fadeIn">
                                {/* Memory 工具使用自定义展示 */}
                                {(() => {
                                  const memoryFormat = formatMemoryDetails(event);
                                  if (memoryFormat.showCustom) {
                                    return memoryFormat.customContent;
                                  }
                                  // 默认展示
                                  return (
                                    <>
                                      {/* Arguments */}
                                      {event.details.arguments != null && (
                                        <div className="mb-2">
                                          <div className="text-xs text-zinc-500 mb-1">参数</div>
                                          <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-x-auto max-h-24">
                                            {JSON.stringify(event.details.arguments as object, null, 2)}
                                          </pre>
                                        </div>
                                      )}
                                      {/* Result */}
                                      {event.details.result != null && (
                                        <div>
                                          <div className="text-xs text-zinc-500 mb-1">结果</div>
                                          <pre className={`text-xs rounded p-2 overflow-x-auto max-h-24 ${
                                            event.status === 'error'
                                              ? 'text-red-300 bg-red-500/10'
                                              : 'text-zinc-400 bg-zinc-900/50'
                                          }`}>
                                            {(() => {
                                              const result = event.details.result as { error?: string; output?: unknown } | undefined;
                                              if (result?.error) return result.error;
                                              if (typeof result?.output === 'string') {
                                                return result.output.slice(0, UI.PREVIEW_TEXT_MAX_LENGTH);
                                              }
                                              return JSON.stringify(result?.output, null, 2)?.slice(0, UI.PREVIEW_TEXT_MAX_LENGTH);
                                            })()}
                                          </pre>
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer Stats */}
      <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-900/30">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>共 {stats.total} 个事件</span>
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <CheckCircle className="w-3 h-3 text-emerald-500" />
              {stats.success}
            </span>
            {stats.error > 0 && (
              <span className="flex items-center gap-1">
                <XCircle className="w-3 h-3 text-red-500" />
                {stats.error}
              </span>
            )}
            {stats.pending > 0 && (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 text-amber-500" />
                {stats.pending}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
};
