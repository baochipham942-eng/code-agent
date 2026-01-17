// ============================================================================
// ObservabilityPanel - AI Execution Observability (Advanced Mode)
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import {
  Target,
  Terminal,
  Wrench,
  Brain,
  Users,
  ChevronRight,
  ChevronDown,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  FileText,
  Search,
  Edit3,
  Globe,
  Sparkles,
  ListTodo,
  HelpCircle,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { Message, ToolCall } from '@shared/types';

// 事件类型
type EventCategory = 'plan' | 'bash' | 'tools' | 'memory' | 'agent';

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

// 分类配置
const categoryConfig: Record<EventCategory, {
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}> = {
  plan: {
    label: 'Plan',
    icon: <Target className="w-3.5 h-3.5" />,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
  },
  bash: {
    label: 'Bash',
    icon: <Terminal className="w-3.5 h-3.5" />,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
  },
  tools: {
    label: 'Tools',
    icon: <Wrench className="w-3.5 h-3.5" />,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
  },
  memory: {
    label: 'Memory',
    icon: <Brain className="w-3.5 h-3.5" />,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10',
  },
  agent: {
    label: 'Agent',
    icon: <Users className="w-3.5 h-3.5" />,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
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
  task: 'agent',
  ask_user_question: 'agent',

  // Skill & Web
  skill: 'agent',
  web_fetch: 'tools',

  // Memory Tools
  memory_store: 'memory',
  memory_search: 'memory',
  code_index: 'memory',
};

// 从工具调用生成摘要
function getToolSummary(toolCall: ToolCall): string {
  const args = toolCall.arguments || {};

  switch (toolCall.name) {
    case 'bash':
      const cmd = (args.command as string) || '';
      return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
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
    case 'todo_write':
      const todos = args.todos as Array<{ content: string }> | undefined;
      return todos ? `更新 ${todos.length} 个待办` : '更新待办事项';
    case 'task':
      return (args.description as string) || '执行子任务';
    case 'ask_user_question':
      return '询问用户';
    case 'skill':
      return `技能: ${args.skill || '未知'}`;
    case 'web_fetch':
      return `获取 ${args.url || '网页'}`;
    case 'memory_store':
      return '存储记忆';
    case 'memory_search':
      return `搜索记忆: ${args.query || ''}`;
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
  };
  return iconMap[name] || <Wrench className="w-3 h-3" />;
}

export const ObservabilityPanel: React.FC = () => {
  const { messages } = useAppStore();
  const [activeTab, setActiveTab] = useState<EventCategory | 'all'>('all');
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

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

  // 按分类过滤
  const filteredEvents = useMemo(() => {
    if (activeTab === 'all') return events;
    return events.filter((e) => e.category === activeTab);
  }, [events, activeTab]);

  // 各分类计数
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: events.length };
    Object.keys(categoryConfig).forEach((cat) => {
      counts[cat] = events.filter((e) => e.category === cat).length;
    });
    return counts;
  }, [events]);

  const toggleExpand = (id: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="w-80 flex flex-col border-l border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-100">执行追踪</h3>
        <p className="text-xs text-zinc-500 mt-0.5">AI 执行步骤的可观测性视图</p>
      </div>

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-zinc-800 bg-zinc-900/30">
        <button
          onClick={() => setActiveTab('all')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            activeTab === 'all'
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
          }`}
        >
          全部 {categoryCounts.all > 0 && <span className="ml-1 text-zinc-400">({categoryCounts.all})</span>}
        </button>
        {(Object.keys(categoryConfig) as EventCategory[]).map((cat) => {
          const config = categoryConfig[cat];
          const count = categoryCounts[cat] || 0;
          return (
            <button
              key={cat}
              onClick={() => setActiveTab(cat)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
                activeTab === cat
                  ? `${config.bgColor} ${config.color}`
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {config.icon}
              <span>{config.label}</span>
              {count > 0 && <span className="text-zinc-400">({count})</span>}
            </button>
          );
        })}
      </div>

      {/* Events List */}
      <div className="flex-1 overflow-y-auto">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="w-10 h-10 rounded-xl bg-zinc-800/50 flex items-center justify-center mb-3">
              <Wrench className="w-5 h-5 text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">暂无执行记录</p>
            <p className="text-xs text-zinc-600 mt-1">开始对话后，AI 的执行步骤将在这里显示</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {filteredEvents.map((event) => {
              const config = categoryConfig[event.category];
              const isExpanded = expandedEvents.has(event.id);

              return (
                <div key={event.id} className="animate-fadeIn">
                  {/* Event Header */}
                  <button
                    onClick={() => toggleExpand(event.id)}
                    className="w-full px-3 py-2.5 flex items-start gap-2 hover:bg-zinc-800/30 transition-colors text-left"
                  >
                    {/* Expand Icon */}
                    <div className={`mt-0.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-600" />
                    </div>

                    {/* Category Icon */}
                    <div className={`p-1.5 rounded-md ${config.bgColor} ${config.color} mt-0.5`}>
                      {getToolIcon(event.name)}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-zinc-300 truncate">
                          {event.summary}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-xs ${config.color}`}>{event.name}</span>
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

                  {/* Expanded Details */}
                  {isExpanded && event.details && (
                    <div className="px-4 pb-3 pl-10 animate-fadeIn">
                      {/* Arguments */}
                      {event.details.arguments && (
                        <div className="mb-2">
                          <div className="text-xs text-zinc-500 mb-1">参数</div>
                          <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded p-2 overflow-x-auto max-h-24">
                            {JSON.stringify(event.details.arguments, null, 2)}
                          </pre>
                        </div>
                      )}
                      {/* Result */}
                      {event.details.result && (
                        <div>
                          <div className="text-xs text-zinc-500 mb-1">结果</div>
                          <pre className={`text-xs rounded p-2 overflow-x-auto max-h-24 ${
                            event.status === 'error'
                              ? 'text-red-300 bg-red-500/10'
                              : 'text-zinc-400 bg-zinc-900/50'
                          }`}>
                            {(event.details.result as any).error
                              || (typeof (event.details.result as any).output === 'string'
                                ? (event.details.result as any).output.slice(0, 500)
                                : JSON.stringify((event.details.result as any).output, null, 2)?.slice(0, 500))}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer Stats */}
      <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-900/30">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>共 {events.length} 个事件</span>
          <span className="flex items-center gap-1">
            <CheckCircle className="w-3 h-3 text-emerald-500" />
            {events.filter((e) => e.status === 'success').length}
            <XCircle className="w-3 h-3 text-red-500 ml-2" />
            {events.filter((e) => e.status === 'error').length}
          </span>
        </div>
      </div>
    </div>
  );
};
