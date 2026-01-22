// ============================================================================
// AssistantMessage - Display AI assistant messages
// ============================================================================

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Bot, ChevronDown, Check, AlertTriangle, Loader2 } from 'lucide-react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay';
import { formatTime } from './utils';
import { useIsCoworkMode } from '../../../../stores/modeStore';

/**
 * Generate a simplified action word for tool calls (Cowork mode)
 */
const getToolActionWord = (toolName: string): string => {
  const actionMap: Record<string, string> = {
    // Gen 1 - Basic file operations
    bash: '执行',
    read_file: '读取',
    write_file: '创建',
    edit_file: '编辑',

    // Gen 2 - Search and navigation
    glob: '搜索',
    grep: '查找',
    list_directory: '浏览',
    web_search: '搜索网络',

    // Gen 3 - Subagent and planning
    task: '委托',
    todo_write: '更新任务',
    ask_user_question: '询问',
    plan_update: '规划',
    plan_read: '查看计划',
    findings_write: '记录',

    // Gen 4 - Skills and network
    skill: '调用技能',
    web_fetch: '获取',
    mcp: '连接服务',

    // Gen 5 - Memory and indexing
    memory_store: '存储',
    memory_search: '回忆',
    code_index: '索引',
    ppt_generate: '生成PPT',
    image_generate: '生成图片',

    // Gen 6 - Computer Use
    screenshot: '截图',
    computer_use: '操作',
    browser_action: '浏览',

    // Gen 7 - Multi-agent
    spawn_agent: '创建代理',
    agent_message: '通信',
    workflow_orchestrate: '编排',

    // Gen 8 - Self-evolution
    strategy_optimize: '优化',
    tool_create: '创建工具',
    self_evaluate: '评估',
  };

  // Handle MCP tools
  if (toolName.startsWith('mcp_') || toolName === 'mcp') {
    return '调用服务';
  }

  return actionMap[toolName] || '处理';
};

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  const isCoworkMode = useIsCoworkMode();
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  // Count successful/failed tool calls
  const toolStats = useMemo(() => {
    return message.toolCalls?.reduce(
      (acc, tc) => {
        if (tc.result?.success) acc.success++;
        else if (tc.result?.error) acc.failed++;
        else acc.pending++;
        return acc;
      },
      { success: 0, failed: 0, pending: 0 }
    ) || { success: 0, failed: 0, pending: 0 };
  }, [message.toolCalls]);

  const totalTools = (toolStats.success + toolStats.failed + toolStats.pending);
  const hasError = toolStats.failed > 0;
  const isPending = toolStats.pending > 0;
  const allSuccess = toolStats.success === totalTools && totalTools > 0;

  // Auto-expand when there are errors, collapse when all successful
  const [showToolDetails, setShowToolDetails] = useState(hasError);

  // Update expanded state when status changes
  useEffect(() => {
    if (hasError && !showToolDetails) {
      setShowToolDetails(true);
    }
  }, [hasError]);

  // Measure content height for smooth animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [showToolDetails, message.toolCalls]);

  // Generate simplified flow text for Cowork mode (e.g., "读取 → 编辑 → 完成")
  const flowText = useMemo(() => {
    if (!message.toolCalls || message.toolCalls.length === 0) return '';

    // Get unique action words, preserving order
    const actions: string[] = [];
    for (const tc of message.toolCalls) {
      const action = getToolActionWord(tc.name);
      // Only add if not same as last action (avoid "读取 → 读取 → 读取")
      if (actions.length === 0 || actions[actions.length - 1] !== action) {
        actions.push(action);
      }
    }

    // Limit to 4 actions max
    if (actions.length > 4) {
      return actions.slice(0, 3).join(' → ') + ' → ...';
    }

    return actions.join(' → ');
  }, [message.toolCalls]);

  // Generate summary text for Cowork mode
  const getSummaryText = (): string => {
    if (isPending) {
      return `正在执行第 ${toolStats.success + 1} 步...`;
    }
    if (hasError) {
      return `${toolStats.failed} 个步骤失败`;
    }
    return `${totalTools} 个步骤已完成`;
  };

  return (
    <div className="flex gap-3 animate-slideUp">
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-accent-purple to-accent-pink">
        <Bot className="w-3.5 h-3.5 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Text content */}
        {message.content && (
          <div className="inline-block rounded-2xl rounded-tl-md px-4 py-2.5 max-w-[85%] bg-zinc-800/70 text-zinc-100 border border-zinc-700/40">
            <MessageContent content={message.content} isUser={false} />
          </div>
        )}

        {/* Tool calls - different display based on mode */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          isCoworkMode ? (
            // Cowork mode: Simplified progressive disclosure
            <div className="mt-3">
              {/* Summary row - always visible */}
              <button
                onClick={() => setShowToolDetails(!showToolDetails)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-200 ${
                  showToolDetails
                    ? 'bg-zinc-800/60 border border-zinc-600/40'
                    : 'bg-zinc-800/30 border border-zinc-700/20 hover:bg-zinc-800/50'
                }`}
              >
                {/* Status icon */}
                <div className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                  hasError
                    ? 'bg-red-500/20 text-red-400'
                    : isPending
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-emerald-500/20 text-emerald-400'
                }`}>
                  {hasError ? (
                    <AlertTriangle className="w-3 h-3" />
                  ) : isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Check className="w-3 h-3" />
                  )}
                </div>

                {/* Summary text */}
                <span className={`text-sm font-medium ${
                  hasError ? 'text-red-300' : isPending ? 'text-amber-300' : 'text-emerald-300'
                }`}>
                  {getSummaryText()}
                </span>

                {/* Flow text - only when not pending and has multiple steps */}
                {!isPending && totalTools > 1 && (
                  <span className="text-xs text-zinc-500 truncate flex-1 text-left">
                    {flowText}
                  </span>
                )}

                {/* Expand indicator */}
                <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${
                  showToolDetails ? 'rotate-0' : '-rotate-90'
                }`} />
              </button>

              {/* Expanded tool details with smooth animation */}
              <div
                ref={contentRef}
                className="overflow-hidden transition-all duration-300 ease-out"
                style={{
                  maxHeight: showToolDetails ? (contentHeight ? `${contentHeight}px` : '2000px') : '0px',
                  opacity: showToolDetails ? 1 : 0,
                }}
              >
                <div className="mt-2 space-y-1.5 pt-1">
                  {message.toolCalls.map((toolCall, index) => (
                    <ToolCallDisplay
                      key={toolCall.id}
                      toolCall={toolCall}
                      index={index}
                      total={message.toolCalls!.length}
                      compact
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            // Developer mode: Full tool display
            <div className="mt-3 space-y-2">
              {message.toolCalls.map((toolCall, index) => (
                <ToolCallDisplay
                  key={toolCall.id}
                  toolCall={toolCall}
                  index={index}
                  total={message.toolCalls!.length}
                />
              ))}
            </div>
          )
        )}

        {/* Timestamp */}
        <div className="text-2xs text-zinc-600 mt-1 ml-1">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};
