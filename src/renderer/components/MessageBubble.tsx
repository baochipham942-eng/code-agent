// ============================================================================
// MessageBubble - Individual Chat Message Display (Enhanced UI/UX)
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  Terminal,
  FileText,
  Copy,
  Check,
  Code2,
  FolderSearch,
  FileEdit,
  Globe,
  Zap,
  Sparkles,
  AlertCircle,
  Play,
  ExternalLink,
  Clock
} from 'lucide-react';
import type { Message, ToolCall, ToolResult } from '@shared/types';
import { useAppStore } from '../stores/appStore';
import { summarizeToolCall, getToolIcon as getToolIconEmoji, getToolStatusText, getToolStatusClass } from '../utils/toolSummary';
import { DiffView, DiffPreview } from './DiffView';

interface MessageBubbleProps {
  message: Message;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <div
      className={`flex gap-3 animate-slideUp ${
        isUser ? 'flex-row-reverse' : ''
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-lg ${
          isUser
            ? 'bg-gradient-to-br from-primary-500 to-primary-600 shadow-primary-500/20'
            : 'bg-gradient-to-br from-accent-purple to-accent-pink shadow-purple-500/20'
        }`}
      >
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-white" />
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
        {/* Text content */}
        {message.content && (
          <div
            className={`inline-block rounded-2xl px-4 py-3 max-w-full shadow-lg ${
              isUser
                ? 'bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-primary-500/10'
                : 'bg-zinc-800/80 text-zinc-100 border border-zinc-700/50 shadow-black/20'
            }`}
          >
            <MessageContent content={message.content} isUser={isUser} />
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
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
        )}

        {/* Timestamp */}
        <div
          className={`text-xs text-zinc-500 mt-1.5 ${
            isUser ? 'text-right' : ''
          }`}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};

// Message content with markdown-like rendering
const MessageContent: React.FC<{ content: string; isUser?: boolean }> = ({ content, isUser }) => {
  // Split by code blocks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          return <CodeBlock key={index} content={part} />;
        }
        // Render inline code for non-user messages
        if (!isUser) {
          return <InlineTextWithCode key={index} text={part} />;
        }
        return <span key={index}>{part}</span>;
      })}
    </div>
  );
};

// Handle inline code within text
const InlineTextWithCode: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(`[^`]+`)/g);

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          const code = part.slice(1, -1);
          return (
            <code
              key={index}
              className="px-1.5 py-0.5 mx-0.5 rounded-md bg-zinc-900/80 text-primary-300 text-xs font-mono border border-zinc-700/50"
            >
              {code}
            </code>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
};

// Language colors and icons
const languageConfig: Record<string, { color: string; icon?: React.ReactNode }> = {
  typescript: { color: 'text-blue-400' },
  javascript: { color: 'text-yellow-400' },
  python: { color: 'text-green-400' },
  rust: { color: 'text-orange-400' },
  go: { color: 'text-cyan-400' },
  bash: { color: 'text-emerald-400' },
  shell: { color: 'text-emerald-400' },
  json: { color: 'text-amber-400' },
  html: { color: 'text-orange-400' },
  css: { color: 'text-blue-400' },
  sql: { color: 'text-purple-400' },
};

// Code block component with enhanced styling
const CodeBlock: React.FC<{ content: string }> = ({ content }) => {
  const [copied, setCopied] = useState(false);

  // Extract language and code
  const match = content.match(/```(\w*)\n?([\s\S]*?)```/);
  const language = match?.[1]?.toLowerCase() || '';
  const code = match?.[2]?.trim() || content.replace(/```/g, '').trim();
  const config = languageConfig[language] || { color: 'text-zinc-400' };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Count lines for line numbers
  const lines = code.split('\n');
  const showLineNumbers = lines.length > 3;

  return (
    <div className="my-3 rounded-xl bg-surface-950 overflow-hidden border border-zinc-800/50 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800/30 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <Code2 className={`w-3.5 h-3.5 ${config.color}`} />
          <span className={`text-xs font-medium ${config.color}`}>
            {language || 'code'}
          </span>
          <span className="text-xs text-zinc-600">
            {lines.length} line{lines.length > 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* Code with optional line numbers */}
      <div className="relative">
        <pre className={`p-4 overflow-x-auto ${showLineNumbers ? 'pl-12' : ''}`}>
          {showLineNumbers && (
            <div className="absolute left-0 top-0 bottom-0 w-10 flex flex-col items-end pr-3 pt-4 text-xs text-zinc-600 select-none bg-zinc-900/30 border-r border-zinc-800/30">
              {lines.map((_, i) => (
                <span key={i} className="leading-5">{i + 1}</span>
              ))}
            </div>
          )}
          <code className="text-xs text-zinc-300 font-mono leading-5">{code}</code>
        </pre>
      </div>
    </div>
  );
};

// Tool icon mapping
const getToolIcon = (name: string) => {
  const iconMap: Record<string, React.ReactNode> = {
    bash: <Terminal className="w-3.5 h-3.5" />,
    read_file: <FileText className="w-3.5 h-3.5" />,
    write_file: <FileEdit className="w-3.5 h-3.5" />,
    edit_file: <FileEdit className="w-3.5 h-3.5" />,
    glob: <FolderSearch className="w-3.5 h-3.5" />,
    grep: <FolderSearch className="w-3.5 h-3.5" />,
    list_directory: <FolderSearch className="w-3.5 h-3.5" />,
    web_fetch: <Globe className="w-3.5 h-3.5" />,
    task: <Zap className="w-3.5 h-3.5" />,
    skill: <Sparkles className="w-3.5 h-3.5" />,
  };
  return iconMap[name] || <Code2 className="w-3.5 h-3.5" />;
};

// Tool call display component with enhanced design
const ToolCallDisplay: React.FC<{ toolCall: ToolCall; index: number; total: number }> = ({
  toolCall,
  index,
  total
}) => {
  // 默认折叠，只有在执行中或出错时展开
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const openPreview = useAppStore((state) => state.openPreview);

  // Get status from result
  const getStatus = (): 'success' | 'error' | 'pending' => {
    if (!toolCall.result) return 'pending';
    return toolCall.result.success ? 'success' : 'error';
  };

  const status = getStatus();

  // 生成工具摘要
  const summary = useMemo(() => summarizeToolCall(toolCall), [toolCall]);
  const toolIcon = useMemo(() => getToolIconEmoji(toolCall.name), [toolCall.name]);
  const statusText = useMemo(() => getToolStatusText(toolCall), [toolCall]);
  const statusClass = useMemo(() => getToolStatusClass(toolCall), [toolCall]);

  // 检测是否为 edit_file 工具调用
  const isEditFile = toolCall.name === 'edit_file';
  const editFileArgs = isEditFile ? {
    filePath: (toolCall.arguments?.file_path as string) || '',
    oldString: (toolCall.arguments?.old_string as string) || '',
    newString: (toolCall.arguments?.new_string as string) || '',
  } : null;

  const statusConfig = {
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

  // Check if this is an HTML file creation
  const getHtmlFilePath = (): string | null => {
    if (toolCall.name === 'write_file' && toolCall.result?.success) {
      // Prefer extracting the absolute path from result output (which is always absolute)
      const output = toolCall.result?.output as string;
      if (output && output.includes('.html')) {
        // Match patterns like "Created file: /path/to/file.html" or "Updated file: /path/to/file.html"
        const match = output.match(/(?:Created|Updated) file: (.+\.html)/);
        if (match) return match[1];
      }
      // Fallback to arguments (may be relative)
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
      className={`rounded-xl bg-zinc-800/40 border border-zinc-700/50 overflow-hidden transition-all duration-200 ${
        expanded ? 'shadow-lg' : ''
      }`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Header - 显示摘要而非工具名 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-700/20 transition-all duration-200"
      >
        {/* Expand indicator */}
        <div className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </div>

        {/* Tool icon with emoji */}
        <div className={`p-2 rounded-lg ${config.bg} text-lg`}>
          <span>{toolIcon}</span>
        </div>

        {/* Tool summary instead of just name */}
        <div className="flex-1 text-left min-w-0">
          <div className="text-sm font-medium text-zinc-200 truncate">{summary}</div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-mono">{toolCall.name}</span>
            {total > 1 && <span className="text-zinc-600">#{index + 1}</span>}
          </div>
        </div>

        {/* Diff preview for edit_file */}
        {isEditFile && editFileArgs && (
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
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs transition-colors border border-blue-500/30"
            title="在右侧预览"
          >
            <Play className="w-3 h-3" />
            预览
          </button>
        )}

        {/* Status badge with duration */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text} ${config.border} border`}>
          {config.icon}
          <span>{statusText}</span>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-zinc-700/30 animate-fadeIn">
          {/* Diff view for edit_file */}
          {isEditFile && editFileArgs && showDiff && (
            <div className="mb-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
                <span>Changes</span>
                <div className="flex-1 h-px bg-zinc-700/50" />
                <button
                  onClick={() => setShowDiff(false)}
                  className="text-zinc-500 hover:text-zinc-300 px-2"
                >
                  隐藏
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

          {/* Arguments - 对 edit_file 显示简化版本 */}
          <div className="mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
              <span>Arguments</span>
              <div className="flex-1 h-px bg-zinc-700/50" />
              {isEditFile && !showDiff && (
                <button
                  onClick={() => setShowDiff(true)}
                  className="text-primary-400 hover:text-primary-300 px-2"
                >
                  查看差异
                </button>
              )}
            </div>
            <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded-lg p-3 overflow-x-auto border border-zinc-800/50">
              {isEditFile && editFileArgs ? (
                // 简化显示 edit_file 参数
                JSON.stringify({
                  file_path: editFileArgs.filePath,
                  old_string: editFileArgs.oldString.length > 100
                    ? `${editFileArgs.oldString.slice(0, 100)}... (${editFileArgs.oldString.length} chars)`
                    : editFileArgs.oldString,
                  new_string: editFileArgs.newString.length > 100
                    ? `${editFileArgs.newString.slice(0, 100)}... (${editFileArgs.newString.length} chars)`
                    : editFileArgs.newString,
                }, null, 2)
              ) : (
                JSON.stringify(toolCall.arguments, null, 2)
              )}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result && (
            <div>
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
              <pre className={`text-xs bg-zinc-900/50 rounded-lg p-3 overflow-x-auto max-h-48 border ${
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

          {/* Open in browser button for HTML files */}
          {htmlFilePath && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => openPreview(htmlFilePath)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                在右侧预览
              </button>
              <button
                onClick={() => {
                  // Open in system default browser
                  window.electronAPI?.invoke('workspace:read-file', htmlFilePath);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 text-zinc-300 hover:bg-zinc-600 text-xs transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                在浏览器打开
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Loader component for pending state
const Loader: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
);

// Helper function
function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}
