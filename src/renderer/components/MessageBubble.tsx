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
  Clock,
  Image as ImageIcon,
  File,
  FileImage,
  Database,
  FileCode,
} from 'lucide-react';
import type { Message, ToolCall, ToolResult, MessageAttachment, AttachmentCategory } from '@shared/types';
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
        {/* Attachments for user messages */}
        {isUser && message.attachments && message.attachments.length > 0 && (
          <AttachmentDisplay attachments={message.attachments} />
        )}

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
        // Render inline code and tables for non-user messages
        if (!isUser) {
          return <RichTextContent key={index} text={part} />;
        }
        return <span key={index}>{part}</span>;
      })}
    </div>
  );
};

// Parse and render markdown tables
const MarkdownTable: React.FC<{ tableText: string }> = ({ tableText }) => {
  const lines = tableText.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) return <span>{tableText}</span>;

  // Parse header
  const headerLine = lines[0];
  const headers = headerLine.split('|').map(h => h.trim()).filter(Boolean);

  // Check for separator line (---|---|---)
  const separatorLine = lines[1];
  if (!separatorLine.match(/^[\s|:-]+$/)) {
    return <span>{tableText}</span>;
  }

  // Parse alignment from separator
  const alignments = separatorLine.split('|').map(s => s.trim()).filter(Boolean).map(sep => {
    if (sep.startsWith(':') && sep.endsWith(':')) return 'center';
    if (sep.endsWith(':')) return 'right';
    return 'left';
  });

  // Parse data rows
  const dataRows = lines.slice(2).map(line =>
    line.split('|').map(cell => cell.trim()).filter((_, i, arr) => i > 0 || arr[0] !== '')
  );

  return (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full text-xs border-collapse">
        <thead>
          <tr className="bg-zinc-800/50">
            {headers.map((header, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left font-semibold text-zinc-200 border border-zinc-700/50"
                style={{ textAlign: alignments[i] || 'left' }}
              >
                <InlineTextWithCode text={header} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className={rowIndex % 2 === 0 ? 'bg-zinc-900/30' : 'bg-zinc-800/20'}
            >
              {headers.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className="px-3 py-2 text-zinc-300 border border-zinc-700/50"
                  style={{ textAlign: alignments[cellIndex] || 'left' }}
                >
                  <InlineTextWithCode text={row[cellIndex] || ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Rich text content with tables, headers, lists and inline formatting
const RichTextContent: React.FC<{ text: string }> = ({ text }) => {
  // Parse text into block-level elements
  const blocks = parseMarkdownBlocks(text);

  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} block={block} />
      ))}
    </>
  );
};

// Block types
type BlockType = 'paragraph' | 'heading' | 'table' | 'list' | 'blockquote' | 'hr';
interface MarkdownBlockData {
  type: BlockType;
  content: string;
  level?: number; // for headings (1-6) and lists
  items?: string[]; // for lists
  ordered?: boolean; // for lists
}

// Parse markdown into blocks
function parseMarkdownBlocks(text: string): MarkdownBlockData[] {
  const blocks: MarkdownBlockData[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr', content: '' });
      i++;
      continue;
    }

    // Heading (# to ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Table detection
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].match(/^[\s|:-]+$/)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'table', content: tableLines.join('\n') });
      continue;
    }

    // Unordered list (-, *, +)
    const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+])\s+(.*)$/);
        if (itemMatch) {
          items.push(itemMatch[3]);
          i++;
        } else if (lines[i].trim() === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', content: '', items, ordered: false });
      continue;
    }

    // Ordered list (1. 2. etc)
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (itemMatch) {
          items.push(itemMatch[3]);
          i++;
        } else if (lines[i].trim() === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', content: '', items, ordered: true });
      continue;
    }

    // Regular paragraph - collect consecutive non-special lines
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const currentLine = lines[i];
      // Stop at special lines
      if (
        currentLine.match(/^#{1,6}\s/) ||
        currentLine.startsWith('>') ||
        currentLine.match(/^(\s*)([-*+]|\d+\.)\s/) ||
        (currentLine.includes('|') && i + 1 < lines.length && lines[i + 1]?.match(/^[\s|:-]+$/)) ||
        currentLine.match(/^(-{3,}|\*{3,}|_{3,})$/)
      ) {
        break;
      }
      paragraphLines.push(currentLine);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paragraphLines.join('\n') });
    }
  }

  return blocks;
}

// Render a single markdown block
const MarkdownBlock: React.FC<{ block: MarkdownBlockData }> = ({ block }) => {
  switch (block.type) {
    case 'hr':
      return <hr className="my-4 border-zinc-700/50" />;

    case 'heading': {
      const HeadingTag = `h${block.level}` as keyof JSX.IntrinsicElements;
      const sizeClasses: Record<number, string> = {
        1: 'text-xl font-bold text-zinc-100 mt-4 mb-2',
        2: 'text-lg font-bold text-zinc-100 mt-3 mb-2',
        3: 'text-base font-semibold text-zinc-200 mt-3 mb-1',
        4: 'text-sm font-semibold text-zinc-200 mt-2 mb-1',
        5: 'text-sm font-medium text-zinc-300 mt-2 mb-1',
        6: 'text-xs font-medium text-zinc-400 mt-2 mb-1',
      };
      return (
        <HeadingTag className={sizeClasses[block.level || 1]}>
          <InlineTextWithCode text={block.content} />
        </HeadingTag>
      );
    }

    case 'blockquote':
      return (
        <blockquote className="my-2 pl-4 border-l-2 border-primary-500/50 text-zinc-400 italic">
          <InlineTextWithCode text={block.content} />
        </blockquote>
      );

    case 'table':
      return <MarkdownTable tableText={block.content} />;

    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag className={`my-2 pl-5 space-y-1 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
          {block.items?.map((item, i) => (
            <li key={i} className="text-zinc-300">
              <InlineTextWithCode text={item} />
            </li>
          ))}
        </ListTag>
      );
    }

    case 'paragraph':
    default:
      return <InlineTextWithCode text={block.content} />;
  }
};

// Handle inline formatting: code, bold, italic, strikethrough
const InlineTextWithCode: React.FC<{ text: string }> = ({ text }) => {
  // Combined regex for inline formatting
  // Order matters: code first, then bold, then italic, then strikethrough
  const inlineRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
  const parts = text.split(inlineRegex);

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;

        // Inline code
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

        // Bold **text**
        if (part.startsWith('**') && part.endsWith('**')) {
          const content = part.slice(2, -2);
          return <strong key={index} className="font-semibold text-zinc-100">{content}</strong>;
        }

        // Italic *text*
        if (part.startsWith('*') && part.endsWith('*')) {
          const content = part.slice(1, -1);
          return <em key={index} className="italic text-zinc-200">{content}</em>;
        }

        // Strikethrough ~~text~~
        if (part.startsWith('~~') && part.endsWith('~~')) {
          const content = part.slice(2, -2);
          return <del key={index} className="line-through text-zinc-500">{content}</del>;
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

// Format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 根据附件类别获取图标和颜色
function getAttachmentIconConfig(category: AttachmentCategory | undefined): { icon: React.ReactNode; color: string; label: string } {
  const iconClass = "w-5 h-5 shrink-0";
  switch (category) {
    case 'pdf':
      return { icon: <FileText className={iconClass} />, color: 'text-red-400', label: 'PDF' };
    case 'code':
      return { icon: <FileCode className={iconClass} />, color: 'text-blue-400', label: '代码' };
    case 'data':
      return { icon: <Database className={iconClass} />, color: 'text-amber-400', label: '数据' };
    case 'html':
      return { icon: <Globe className={iconClass} />, color: 'text-orange-400', label: 'HTML' };
    case 'text':
      return { icon: <FileText className={iconClass} />, color: 'text-zinc-400', label: '文本' };
    default:
      return { icon: <File className={iconClass} />, color: 'text-zinc-500', label: '文件' };
  }
}

// 文件夹摘要阈值 - 超过这个数量就显示摘要形式
const FOLDER_SUMMARY_THRESHOLD = 5;

// Attachment display component
const AttachmentDisplay: React.FC<{ attachments: MessageAttachment[] }> = ({ attachments }) => {
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // 统计文件类型
  const stats = useMemo(() => {
    const byCategory: Record<string, number> = {};
    let totalSize = 0;

    for (const att of attachments) {
      const cat = att.category || (att.type === 'image' ? 'image' : 'other');
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      totalSize += att.size;
    }

    // 检测是否来自同一个文件夹
    const firstSlash = attachments[0]?.name.indexOf('/');
    const folderName = firstSlash > 0 ? attachments[0].name.substring(0, firstSlash) : null;
    const isFromFolder = folderName && attachments.every((a) => a.name.startsWith(folderName + '/'));

    return { byCategory, totalSize, folderName: isFromFolder ? folderName : null };
  }, [attachments]);

  // 如果文件数量超过阈值，显示摘要形式
  const showSummary = attachments.length > FOLDER_SUMMARY_THRESHOLD;

  // 摘要视图
  if (showSummary && !isExpanded) {
    const categoryLabels: Record<string, string> = {
      image: '图片',
      pdf: 'PDF',
      code: '代码',
      data: '数据',
      text: '文本',
      html: 'HTML',
      other: '其他',
    };

    const summaryParts = Object.entries(stats.byCategory)
      .map(([cat, count]) => `${count} ${categoryLabels[cat] || cat}`)
      .join(', ');

    return (
      <div className="mb-2 flex justify-end">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-800/60 border border-zinc-700/50 cursor-pointer hover:bg-zinc-700/60 transition-colors"
          onClick={() => setIsExpanded(true)}
        >
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary-500/20 to-accent-purple/20 flex items-center justify-center">
            <FolderSearch className="w-5 h-5 text-primary-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-zinc-200 font-medium">
              {stats.folderName ? `📁 ${stats.folderName}` : `📎 ${attachments.length} 个文件`}
            </div>
            <div className="text-xs text-zinc-500">
              {summaryParts} · {formatFileSize(stats.totalSize)}
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2">
      {/* 折叠按钮（当展开时显示） */}
      {showSummary && isExpanded && (
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setIsExpanded(false)}
            className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
          >
            <ChevronDown className="w-3 h-3" />
            收起 {attachments.length} 个文件
          </button>
        </div>
      )}

      {/* 文件列表 */}
      <div className="flex flex-wrap gap-2 justify-end">
        {attachments.map((attachment) => {
          const category = attachment.category || (attachment.type === 'image' ? 'image' : 'other');

          return (
            <div key={attachment.id}>
              {category === 'image' ? (
                // 图片附件
                <div
                  className="relative group cursor-pointer"
                  onClick={() => setExpandedImage(attachment.thumbnail || attachment.data || null)}
                >
                  <img
                    src={attachment.thumbnail || attachment.data}
                    alt={attachment.name}
                    className="max-w-[200px] max-h-[150px] rounded-xl border border-zinc-700/50 shadow-lg object-cover hover:border-primary-500/50 transition-colors"
                  />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center">
                    <ImageIcon className="w-6 h-6 text-white" />
                  </div>
                </div>
              ) : (
                // 文件附件（按类别显示不同样式）
                (() => {
                  const { icon, color, label } = getAttachmentIconConfig(category);
                  // 只显示文件名最后一部分（去掉文件夹路径）
                  const displayName = attachment.name.includes('/')
                    ? attachment.name.split('/').pop() || attachment.name
                    : attachment.name;
                  return (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-800/60 border border-zinc-700/50 max-w-[200px]">
                      <span className={color}>{icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-200 truncate" title={attachment.name}>
                          {displayName}
                        </div>
                        <div className="text-xs text-zinc-500 flex items-center gap-1">
                          <span className={`${color} text-2xs`}>{label}</span>
                          <span>·</span>
                          {category === 'pdf' && attachment.pageCount
                            ? <span>{attachment.pageCount} 页</span>
                            : attachment.language
                              ? <span>{attachment.language}</span>
                              : <span>{formatFileSize(attachment.size)}</span>
                          }
                        </div>
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          );
        })}
      </div>

      {/* 图片放大弹窗 */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Expanded"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};
