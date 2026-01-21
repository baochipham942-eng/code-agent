// ============================================================================
// ToolCallDisplay - Display tool call execution and results
// ============================================================================

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ChevronDown,
  Terminal,
  FileText,
  FilePlus,
  FileEdit,
  FolderOpen,
  Search,
  Globe,
  Bot,
  ListTodo,
  MessageCircleQuestion,
  Sparkles,
  Plug,
  Database,
  FileCode,
  Camera,
  Monitor,
  Users,
  MessageSquare,
  GitBranch,
  Target,
  Wrench,
  ScanEye,
  ClipboardList,
  Clipboard,
  Check,
  AlertCircle,
  Play,
  Clock,
} from 'lucide-react';
import type { ToolCallDisplayProps, ToolStatus, ToolStatusConfig } from './types';
import { useAppStore } from '../../../../stores/appStore';
import { summarizeToolCall, getToolStatusText } from '../../../../utils/toolSummary';
import { DiffView, DiffPreview } from '../../../DiffView';

// Tool icon mapping - 统一使用 Lucide 图标
const getToolIcon = (name: string): React.ReactNode => {
  const iconMap: Record<string, React.ReactNode> = {
    // Gen 1 - 基础文件操作
    bash: <Terminal className="w-3.5 h-3.5" />,
    read_file: <FileText className="w-3.5 h-3.5" />,
    write_file: <FilePlus className="w-3.5 h-3.5" />,
    edit_file: <FileEdit className="w-3.5 h-3.5" />,

    // Gen 2 - 搜索和导航
    glob: <Search className="w-3.5 h-3.5" />,
    grep: <Search className="w-3.5 h-3.5" />,
    list_directory: <FolderOpen className="w-3.5 h-3.5" />,
    web_search: <Globe className="w-3.5 h-3.5" />,

    // Gen 3 - 子代理和规划
    task: <Bot className="w-3.5 h-3.5" />,
    todo_write: <ListTodo className="w-3.5 h-3.5" />,
    ask_user_question: <MessageCircleQuestion className="w-3.5 h-3.5" />,

    // Gen 4 - 技能系统和网络
    skill: <Sparkles className="w-3.5 h-3.5" />,
    web_fetch: <Globe className="w-3.5 h-3.5" />,
    mcp: <Plug className="w-3.5 h-3.5" />,

    // Gen 5 - RAG 和长期记忆
    memory_store: <Database className="w-3.5 h-3.5" />,
    memory_search: <Search className="w-3.5 h-3.5" />,
    code_index: <FileCode className="w-3.5 h-3.5" />,

    // Gen 6 - Computer Use
    screenshot: <Camera className="w-3.5 h-3.5" />,
    computer_use: <Monitor className="w-3.5 h-3.5" />,
    browser_action: <Globe className="w-3.5 h-3.5" />,

    // Gen 7 - 多代理协同
    spawn_agent: <Users className="w-3.5 h-3.5" />,
    agent_message: <MessageSquare className="w-3.5 h-3.5" />,
    workflow_orchestrate: <GitBranch className="w-3.5 h-3.5" />,

    // Gen 8 - 自我进化
    strategy_optimize: <Target className="w-3.5 h-3.5" />,
    tool_create: <Wrench className="w-3.5 h-3.5" />,
    self_evaluate: <ScanEye className="w-3.5 h-3.5" />,

    // Planning 工具
    plan_update: <ClipboardList className="w-3.5 h-3.5" />,
    plan_read: <Clipboard className="w-3.5 h-3.5" />,
    findings_write: <FileText className="w-3.5 h-3.5" />,
  };

  // MCP 工具使用 Plug 图标
  if (name.startsWith('mcp_') || name === 'mcp') {
    return <Plug className="w-3.5 h-3.5" />;
  }

  return iconMap[name] || <Wrench className="w-3.5 h-3.5" />;
};

// Loader component for pending state
const Loader: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
);

// 格式化工具参数为用户友好的显示
const formatToolArgs = (toolName: string, args: Record<string, unknown> | undefined): string => {
  if (!args) return '无参数';

  switch (toolName) {
    case 'read_file': {
      let filePath = (args.file_path as string) || '';
      // 清理混入的参数
      if (filePath.includes(' offset=') || filePath.includes(' limit=')) {
        filePath = filePath.split(' ')[0];
      }
      const offset = args.offset as number;
      const limit = args.limit as number;
      let result = `文件: ${filePath}`;
      if (offset && offset > 1) result += `\n起始行: ${offset}`;
      if (limit && limit !== 2000) result += `\n读取行数: ${limit}`;
      return result;
    }

    case 'write_file': {
      const filePath = (args.file_path as string) || '';
      const content = (args.content as string) || '';
      return `文件: ${filePath}\n内容长度: ${content.length} 字符`;
    }

    case 'bash': {
      const command = (args.command as string) || '';
      return `命令:\n${command}`;
    }

    case 'glob': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return `模式: ${pattern}\n目录: ${path}`;
    }

    case 'grep': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return `搜索: ${pattern}\n目录: ${path}`;
    }

    case 'list_directory': {
      const path = (args.path as string) || '.';
      return `目录: ${path}`;
    }

    default:
      // 其他工具显示简化的 JSON
      return JSON.stringify(args, null, 2);
  }
};

// Status config
const statusConfig: Record<ToolStatus, ToolStatusConfig> = {
  success: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    border: 'border-emerald-500/20',
    icon: <Check className="w-3 h-3" />,
    label: 'Success'
  },
  error: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    border: 'border-red-500/20',
    icon: <AlertCircle className="w-3 h-3" />,
    label: 'Error'
  },
  pending: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    border: 'border-amber-500/20',
    icon: <Loader className="w-3 h-3 animate-spin" />,
    label: 'Running'
  }
};

// Main tool call display component
export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({
  toolCall,
  index,
  total
}) => {
  const openPreview = useAppStore((state) => state.openPreview);
  const contentRef = useRef<HTMLDivElement>(null);

  // Get status from result
  const getStatus = (): ToolStatus => {
    if (!toolCall.result) return 'pending';
    return toolCall.result.success ? 'success' : 'error';
  };

  const status = getStatus();

  // Default: expand only when pending (running) or error
  const [expanded, setExpanded] = useState(status === 'pending' || status === 'error');
  const [showDiff, setShowDiff] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  // Update expanded state when status changes (auto-collapse on success)
  useEffect(() => {
    if (status === 'success' && expanded) {
      // Auto-collapse on success after a short delay
      const timer = setTimeout(() => {
        setExpanded(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Measure content height for smooth animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [expanded, showDiff, toolCall.result]);

  // Handle expand/collapse with animation
  const toggleExpanded = () => {
    setIsAnimating(true);
    setExpanded(!expanded);
    setTimeout(() => setIsAnimating(false), 250);
  };

  // Generate tool summary
  const summary = useMemo(() => summarizeToolCall(toolCall), [toolCall]);
  const statusText = useMemo(() => getToolStatusText(toolCall), [toolCall]);

  // Check if this is edit_file tool call
  const isEditFile = toolCall.name === 'edit_file';
  const editFileArgs = isEditFile ? {
    filePath: (toolCall.arguments?.file_path as string) || '',
    oldString: (toolCall.arguments?.old_string as string) || '',
    newString: (toolCall.arguments?.new_string as string) || '',
  } : null;

  // Check if this is an HTML file creation
  const getHtmlFilePath = (): string | null => {
    if (toolCall.name === 'write_file' && toolCall.result?.success) {
      // Prefer extracting the absolute path from result output
      const output = toolCall.result?.output as string;
      if (output && output.includes('.html')) {
        const match = output.match(/(?:Created|Updated) file: (.+\.html)/);
        if (match) return match[1];
      }
      // Fallback to arguments
      const filePath = toolCall.arguments?.file_path as string;
      if (filePath && filePath.endsWith('.html')) {
        return filePath;
      }
    }
    return null;
  };

  const config = statusConfig[status];
  const htmlFilePath = getHtmlFilePath();

  return (
    <div
      className={`rounded-xl bg-zinc-800/40 border overflow-hidden transition-all duration-300 ${
        expanded ? 'shadow-lg border-zinc-600/60' : 'border-zinc-700/50'
      } ${status === 'pending' ? 'ring-1 ring-amber-500/30' : ''}`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Header - Collapsible trigger */}
      <button
        onClick={toggleExpanded}
        className={`w-full flex items-center gap-3 px-4 py-3 transition-all duration-200 ${
          expanded ? 'bg-zinc-700/30' : 'hover:bg-zinc-700/20'
        }`}
      >
        {/* Expand/Collapse indicator with smooth rotation */}
        <div
          className={`flex-shrink-0 transition-transform duration-300 ease-out ${
            expanded ? 'rotate-0' : '-rotate-90'
          }`}
        >
          <ChevronDown className="w-4 h-4 text-zinc-500" />
        </div>

        {/* Tool icon - Lucide icons */}
        <div className={`flex-shrink-0 p-2 rounded-lg transition-colors duration-200 ${config.bg} ${config.text}`}>
          {getToolIcon(toolCall.name)}
        </div>

        {/* Tool summary - always visible */}
        <div className="flex-1 text-left min-w-0">
          <div className="text-sm font-medium text-zinc-200 truncate">{summary}</div>
          {/* Tool name and index - show inline when collapsed, below when expanded */}
          <div className={`flex items-center gap-2 text-xs text-zinc-500 transition-opacity duration-200 ${
            expanded ? 'opacity-100' : 'opacity-70'
          }`}>
            <span className="font-mono">{toolCall.name}</span>
            {total > 1 && <span className="text-zinc-600">#{index + 1}</span>}
          </div>
        </div>

        {/* Diff preview for edit_file - only when collapsed */}
        {!expanded && isEditFile && editFileArgs && (
          <DiffPreview
            oldText={editFileArgs.oldString}
            newText={editFileArgs.newString}
            onClick={(e) => {
              e?.stopPropagation?.();
              setShowDiff(true);
              setExpanded(true);
            }}
          />
        )}

        {/* Preview button for HTML files */}
        {htmlFilePath && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openPreview(htmlFilePath);
            }}
            className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs transition-colors border border-blue-500/30"
            title="Preview in sidebar"
          >
            <Play className="w-3 h-3" />
            Preview
          </button>
        )}

        {/* Status badge with duration */}
        <div className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors duration-200 ${config.bg} ${config.text} ${config.border} border`}>
          {config.icon}
          <span>{statusText}</span>
        </div>
      </button>

      {/* Expandable content with smooth height animation */}
      <div
        ref={contentRef}
        className={`overflow-hidden transition-all duration-300 ease-out ${
          isAnimating ? 'transition-none' : ''
        }`}
        style={{
          maxHeight: expanded ? (contentHeight ? `${contentHeight}px` : '1000px') : '0px',
          opacity: expanded ? 1 : 0,
        }}
      >
        <div className="px-4 pb-4 pt-2 border-t border-zinc-700/30">
          {/* Diff view for edit_file */}
          {isEditFile && editFileArgs && showDiff && (
            <div className="mb-3 animate-fadeIn">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
                <span>Diff View</span>
                <div className="flex-1 h-px bg-zinc-700/50" />
                <button
                  onClick={() => setShowDiff(false)}
                  className="text-zinc-500 hover:text-zinc-300 px-2 transition-colors"
                >
                  Collapse
                </button>
              </div>
              <DiffView
                oldText={editFileArgs.oldString}
                newText={editFileArgs.newString}
                fileName={editFileArgs.filePath.split('/').pop()}
                className="border border-zinc-700/50"
              />
            </div>
          )}

          {/* Arguments section */}
          <div className="mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
              <span>Arguments</span>
              <div className="flex-1 h-px bg-zinc-700/50" />
              {isEditFile && !showDiff && (
                <button
                  onClick={() => setShowDiff(true)}
                  className="text-primary-400 hover:text-primary-300 px-2 transition-colors"
                >
                  View Diff
                </button>
              )}
            </div>
            <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded-lg p-3 overflow-x-auto border border-zinc-800/50 whitespace-pre-wrap">
              {isEditFile && editFileArgs ? (
                `File: ${editFileArgs.filePath}\nChanges: ${editFileArgs.oldString.length} -> ${editFileArgs.newString.length} chars`
              ) : (
                formatToolArgs(toolCall.name, toolCall.arguments)
              )}
            </pre>
          </div>

          {/* Result section */}
          {toolCall.result && (
            <div className="animate-fadeIn">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
                <span>Result</span>
                <div className="flex-1 h-px bg-zinc-700/50" />
                {toolCall.result.duration && (
                  <span className="flex items-center gap-1 text-zinc-600">
                    <Clock className="w-3 h-3" />
                    {toolCall.result.duration < 1000
                      ? `${toolCall.result.duration}ms`
                      : `${(toolCall.result.duration / 1000).toFixed(1)}s`
                    }
                  </span>
                )}
              </div>
              <pre className={`text-xs bg-zinc-900/50 rounded-lg p-3 overflow-x-auto max-h-48 border transition-colors duration-200 ${
                status === 'error'
                  ? 'text-red-300 border-red-500/20'
                  : 'text-zinc-400 border-zinc-800/50'
              }`}>
                {toolCall.result.error
                  ? toolCall.result.error
                  : typeof toolCall.result.output === 'string'
                    ? toolCall.result.output
                    : JSON.stringify(toolCall.result.output, null, 2)}
              </pre>
            </div>
          )}

          {/* Pending indicator */}
          {status === 'pending' && (
            <div className="flex items-center gap-2 text-xs text-amber-400/80 mt-2">
              <div className="flex gap-1">
                <span className="typing-dot w-1.5 h-1.5 bg-amber-400 rounded-full" />
                <span className="typing-dot w-1.5 h-1.5 bg-amber-400 rounded-full" />
                <span className="typing-dot w-1.5 h-1.5 bg-amber-400 rounded-full" />
              </div>
              <span>Executing...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
