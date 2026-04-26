// ============================================================================
// MessageContent - Markdown rendering using react-markdown
// ============================================================================

import React, { useState, useMemo, useCallback, memo, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Code2, Copy, Check, ExternalLink, Play, ZoomIn, ZoomOut, Send, PenLine, Terminal, Eye, ClipboardCopy } from 'lucide-react';
import mermaid from 'mermaid';
import type { MessageContentProps } from './types';
import { UI } from '@shared/constants';
import 'katex/dist/katex.min.css';
import type { Components } from 'react-markdown';
import type { Element } from 'hast';
import { useAppStore } from '../../../../stores/appStore';
import { wrapFilePathsInBackticks, wrapTicketsAsLinks } from './filePathProcessor';
import { isWebMode, copyPathToClipboard } from '../../../../utils/platform';
import { ChartBlock } from './ChartBlock';
import { LinkPreviewCard, isRawUrlLink } from './LinkPreviewCard';
import { GenerativeUIBlock } from './GenerativeUIBlock';
import { SpreadsheetBlock } from './SpreadsheetBlock';
import { DocumentBlock } from './DocumentBlock';

// Language display names and colors
const languageConfig: Record<string, { color: string; name: string }> = {
  typescript: { color: 'text-blue-400', name: 'TypeScript' },
  ts: { color: 'text-blue-400', name: 'TypeScript' },
  tsx: { color: 'text-blue-400', name: 'TSX' },
  javascript: { color: 'text-yellow-400', name: 'JavaScript' },
  js: { color: 'text-yellow-400', name: 'JavaScript' },
  jsx: { color: 'text-yellow-400', name: 'JSX' },
  python: { color: 'text-green-400', name: 'Python' },
  py: { color: 'text-green-400', name: 'Python' },
  rust: { color: 'text-orange-400', name: 'Rust' },
  rs: { color: 'text-orange-400', name: 'Rust' },
  go: { color: 'text-cyan-400', name: 'Go' },
  bash: { color: 'text-emerald-400', name: 'Bash' },
  shell: { color: 'text-emerald-400', name: 'Shell' },
  sh: { color: 'text-emerald-400', name: 'Shell' },
  zsh: { color: 'text-emerald-400', name: 'Zsh' },
  json: { color: 'text-amber-400', name: 'JSON' },
  html: { color: 'text-orange-400', name: 'HTML' },
  css: { color: 'text-blue-400', name: 'CSS' },
  scss: { color: 'text-pink-400', name: 'SCSS' },
  sql: { color: 'text-purple-400', name: 'SQL' },
  yaml: { color: 'text-red-400', name: 'YAML' },
  yml: { color: 'text-red-400', name: 'YAML' },
  markdown: { color: 'text-zinc-400', name: 'Markdown' },
  md: { color: 'text-zinc-400', name: 'Markdown' },
  java: { color: 'text-red-400', name: 'Java' },
  c: { color: 'text-blue-300', name: 'C' },
  cpp: { color: 'text-blue-300', name: 'C++' },
  csharp: { color: 'text-purple-400', name: 'C#' },
  cs: { color: 'text-purple-400', name: 'C#' },
  php: { color: 'text-indigo-400', name: 'PHP' },
  ruby: { color: 'text-red-400', name: 'Ruby' },
  rb: { color: 'text-red-400', name: 'Ruby' },
  swift: { color: 'text-orange-400', name: 'Swift' },
  kotlin: { color: 'text-purple-400', name: 'Kotlin' },
  kt: { color: 'text-purple-400', name: 'Kotlin' },
  dart: { color: 'text-cyan-400', name: 'Dart' },
  diff: { color: 'text-zinc-400', name: 'Diff' },
  xml: { color: 'text-orange-400', name: 'XML' },
  toml: { color: 'text-zinc-400', name: 'TOML' },
  ini: { color: 'text-zinc-400', name: 'INI' },
  dockerfile: { color: 'text-cyan-400', name: 'Dockerfile' },
  docker: { color: 'text-cyan-400', name: 'Docker' },
  graphql: { color: 'text-pink-400', name: 'GraphQL' },
  gql: { color: 'text-pink-400', name: 'GraphQL' },
  mermaid: { color: 'text-pink-300', name: 'Mermaid' },
  chart: { color: 'text-emerald-400', name: 'Chart' },
  spreadsheet: { color: 'text-emerald-400', name: 'Spreadsheet' },
  document: { color: 'text-blue-400', name: 'Document' },
  generative_ui: { color: 'text-violet-400', name: 'Generative UI' },
};

// Initialize mermaid once
let mermaidInitialized = false;
function ensureMermaidInit() {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#18181b',
        primaryColor: '#3b82f6',
        primaryTextColor: '#e4e4e7',
        primaryBorderColor: '#3f3f46',
        lineColor: '#71717a',
        secondaryColor: '#27272a',
        tertiaryColor: '#1f1f23',
      },
    });
    mermaidInitialized = true;
  }
}

// Unique ID counter for mermaid diagrams
let mermaidIdCounter = 0;

// Mermaid diagram renderer
const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [copied, setCopiedState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureMermaidInit();

    const id = `mermaid-${++mermaidIdCounter}`;
    mermaid.render(id, code).then(({ svg }) => {
      if (!cancelled && containerRef.current) {
        containerRef.current.innerHTML = svg;
        // Make SVG responsive
        const svgEl = containerRef.current.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
        }
        setError(null);
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err?.message || 'Failed to render diagram');
      }
    });

    return () => { cancelled = true; };
  }, [code]);

  const handleCopyCode = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopiedState(true);
    setTimeout(() => setCopiedState(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  if (error) {
    return <CodeBlock language="mermaid" code={code} />;
  }

  return (
    <div className="my-3 rounded-xl bg-zinc-900 overflow-hidden border border-zinc-700 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <Code2 className="w-3.5 h-3.5 text-pink-300" />
          <span className="text-xs font-medium text-pink-300">Mermaid</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale(s => Math.max(0.5, s - 0.25))}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="缩小"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setScale(1)}
            className="px-1.5 py-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 transition-colors text-xs"
            title="重置"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            onClick={() => setScale(s => Math.min(3, s + 0.25))}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-zinc-700 mx-1" />
          <button
            onClick={handleCopyCode}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-400" />
                <span className="text-green-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Code</span>
              </>
            )}
          </button>
        </div>
      </div>
      {/* Diagram */}
      <div className="overflow-auto p-4">
        <div
          ref={containerRef}
          style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
          className="transition-transform duration-150"
        />
      </div>
    </div>
  );
});

// Threshold for collapsible code blocks
const CODE_COLLAPSE_LINES = 25;

// Code block with copy button and syntax highlighting
const CodeBlock = memo(function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const config = languageConfig[language] || { color: 'text-zinc-400', name: language || 'code' };
  const lines = code.split('\n');
  const showLineNumbers = lines.length > 3;
  const isLong = lines.length > CODE_COLLAPSE_LINES;

  // Auto-collapse long blocks on mount
  useEffect(() => {
    if (isLong) setCollapsed(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  const displayCode = collapsed ? lines.slice(0, CODE_COLLAPSE_LINES).join('\n') : code;

  return (
    <div className="my-3 rounded-xl bg-zinc-800-950 overflow-hidden border border-zinc-700 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <Code2 className={`w-3.5 h-3.5 ${config.color}`} />
          <span className={`text-xs font-medium ${config.color}`}>
            {config.name}
          </span>
          <span className="text-xs text-zinc-600">
            {lines.length} line{lines.length > 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Wrap toggle */}
          <button
            onClick={() => setWrapLines(!wrapLines)}
            className={`px-1.5 py-1 rounded-lg text-xs transition-all ${
              wrapLines
                ? 'bg-zinc-700 text-zinc-200'
                : 'hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300'
            }`}
            title={wrapLines ? '取消换行' : '自动换行'}
          >
            Wrap
          </button>
          {/* Copy */}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
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
      </div>
      {/* Code with syntax highlighting */}
      <div className="relative">
        <SyntaxHighlighter
          style={oneDark}
          language={language || 'text'}
          showLineNumbers={showLineNumbers}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.75rem',
            lineHeight: '1.25rem',
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: 'rgb(113 113 122)',
            userSelect: 'none',
          }}
          wrapLongLines={wrapLines}
        >
          {displayCode}
        </SyntaxHighlighter>
      </div>
      {/* Expand/collapse for long blocks */}
      {isLong && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full py-1.5 text-xs text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 border-t border-zinc-700 transition-colors"
        >
          {collapsed ? `展开全部 (${lines.length} 行)` : '收起'}
        </button>
      )}
    </div>
  );
});

// File extension patterns that can be opened
const OPENABLE_FILE_EXTENSIONS = [
  '.html', '.htm', '.pdf', '.txt', '.md',
  '.json', '.xml', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.webm',
  // Office documents
  '.pptx', '.ppt', '.xlsx', '.xls', '.docx', '.doc',
  // Source code files
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
  '.java', '.rb', '.vue', '.css', '.scss',
];

// Check if text looks like an openable file path
// Supports: /abs/path.ext, ./rel/path.ext, ~/path.ext, src/multi/segment.ext
// Also supports :lineNumber suffix (e.g., src/main/agent.ts:42)
const isFilePath = (text: string): boolean => {
  const trimmed = text.trim();

  // Strip optional :lineNumber suffix before checking extension
  const pathWithoutLine = trimmed.replace(/:\d+$/, '');

  // Check extension match
  const hasExtension = OPENABLE_FILE_EXTENSIONS.some(ext =>
    pathWithoutLine.toLowerCase().endsWith(ext)
  );
  if (!hasExtension) return false;

  // Absolute, explicit relative, or home paths
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('~/')) {
    return true;
  }

  // Multi-segment relative path (e.g., src/components/App.tsx)
  // Must have at least 2 path segments (one /) and an extension
  const segments = pathWithoutLine.split('/');
  if (segments.length >= 2 && segments.every(s => s.length > 0)) {
    return true;
  }

  // Single filename with known extension (e.g., 01-slide-cover.png, report.pdf)
  // Must look like a filename: no spaces, has a dot+ext
  if (segments.length === 1 && /^[\w][\w.\-]*\.\w+$/.test(pathWithoutLine)) {
    return true;
  }

  return false;
};

// Check if file is HTML (can be previewed in-app)
const isHtmlFile = (text: string): boolean => {
  const trimmed = text.trim().toLowerCase();
  return trimmed.endsWith('.html') || trimmed.endsWith('.htm');
};

/**
 * Parse optional :lineNumber suffix from a file path.
 * Returns { path, lineNumber } where lineNumber is undefined if not present.
 */
function parseFilePathWithLine(text: string): { path: string; lineNumber?: number } {
  const match = text.trim().match(/^(.+):(\d+)$/);
  if (match) {
    return { path: match[1], lineNumber: parseInt(match[2], 10) };
  }
  return { path: text.trim() };
}

// Inline code component with file click support
const InlineCode = memo(function InlineCode({
  children,
  onOpenFile,
  onPreviewHtml,
}: {
  children: React.ReactNode;
  onOpenFile?: (filePath: string, lineNumber?: number) => void;
  onPreviewHtml?: (filePath: string) => void;
}) {
  const text = String(children);
  const isFile = isFilePath(text);
  const isHtml = isHtmlFile(text);

  // Regular inline code (not a file) — Codex 风格：无 border，柔和灰底
  if (!isFile) {
    return (
      <code className="px-1.5 py-0.5 mx-0.5 rounded-md bg-white/[0.06] text-zinc-200 text-xs font-mono">
        {children}
      </code>
    );
  }

  // File path - make it clickable
  const { path: filePath, lineNumber } = parseFilePathWithLine(text);

  return (
    <code
      className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-white/[0.06] text-primary-300 text-xs font-mono cursor-pointer hover:bg-white/[0.1] hover:text-primary-200 transition-colors group"
      onClick={() => {
        if (isHtml && onPreviewHtml) {
          onPreviewHtml(filePath);
        } else if (onOpenFile) {
          onOpenFile(filePath, lineNumber);
        }
      }}
      title={isHtml ? '点击预览' : lineNumber ? `点击打开文件（第 ${lineNumber} 行）` : '点击打开文件'}
    >
      {children}
      {isHtml ? (
        <Play className="w-3 h-3 opacity-50 group-hover:opacity-100 text-blue-400" />
      ) : (
        <ExternalLink className="w-3 h-3 opacity-50 group-hover:opacity-100" />
      )}
    </code>
  );
});

// System tags that should be filtered from user-visible content
const SYSTEM_TAG_PATTERNS = [
  /<critical-warning>[\s\S]*?<\/critical-warning>/g,
  /<duplicate-call-warning>[\s\S]*?<\/duplicate-call-warning>/g,
  /<tool-call-format-error>[\s\S]*?<\/tool-call-format-error>/g,
  /<anti-pattern-warning>[\s\S]*?<\/anti-pattern-warning>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<loop-prevention>[\s\S]*?<\/loop-prevention>/g,
  // 工具调用 XML 格式泄漏 - 过滤完整的工具调用块
  /<tool_call>[\s\S]*?<\/tool_call>/g,
  // 过滤残留的闭合标签（模型可能只输出部分 XML）
  /<\/arg_value>/g,
  /<\/tool_call>/g,
  /<arg_name>[^<]*<\/arg_name>/g,
  /<arg_value>/g,
  /<tool_call>/g,
  // 过滤 think 标签（模型推理过程不应显示给用户）
  /<think>[\s\S]*?<\/think>/g,
  /<\/think>/g,
  /<think>/g,
  // 过滤 skill 加载状态标签（应由 SkillStatusMessage 组件渲染，此处作为兜底）
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
];

/**
 * Filter out system-injected tags that shouldn't be shown to users
 */
function filterSystemTags(text: string): string {
  let filtered = text;
  for (const pattern of SYSTEM_TAG_PATTERNS) {
    filtered = filtered.replace(pattern, '');
  }
  // Clean up multiple consecutive newlines left by removed tags
  filtered = filtered.replace(/\n{3,}/g, '\n\n');
  return filtered.trim();
}

// IACT Copy button with copied state feedback
const IACTCopyButton: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  const text = typeof children === 'string' ? children
    : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
    : String(children ?? '');
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-zinc-500/10 text-zinc-400 hover:bg-zinc-500/20 hover:text-zinc-300 border border-zinc-500/20 hover:border-zinc-500/40 transition-all cursor-pointer text-sm font-medium"
      title="复制到剪贴板"
    >
      {children}
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <ClipboardCopy className="w-3 h-3 opacity-60" />}
    </button>
  );
};

// Main message content component
export const MessageContent: React.FC<MessageContentProps> = memo(function MessageContent({ content, isUser }) {
  const openPreview = useAppStore((state) => state.openPreview);
  const workingDirectory = useAppStore((state) => state.workingDirectory);

  // Handle opening a file externally
  const handleOpenFile = useCallback(async (filePath: string, lineNumber?: number) => {
    try {
      // Resolve relative paths
      let fullPath = filePath;
      if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
        fullPath = workingDirectory ? `${workingDirectory}/${filePath}` : filePath;
      }
      if (isWebMode()) {
        await copyPathToClipboard(fullPath);
        return;
      }
      await window.domainAPI?.invoke('workspace', 'openPath', { filePath: fullPath, lineNumber });
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  }, [workingDirectory]);

  // Handle previewing HTML in-app
  const handlePreviewHtml = useCallback((filePath: string) => {
    // Resolve relative paths
    let fullPath = filePath;
    if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
      fullPath = workingDirectory ? `${workingDirectory}/${filePath}` : filePath;
    }
    openPreview(fullPath);
  }, [openPreview, workingDirectory]);

  // For user messages, render as plain text (no markdown processing)
  // 使用 span 而非 div，避免复制时末尾多出换行符
  if (isUser) {
    return (
      <span className="text-sm leading-relaxed whitespace-pre-wrap break-words block">
        {content}
      </span>
    );
  }

  // Custom components for react-markdown
  const components: Components = useMemo(
    () => ({
      // Code blocks and inline code
      code({ node, className, children, ...props }) {
        // Check if this is a code block (has a parent pre element)
        // react-markdown wraps code blocks in <pre><code>
        const isCodeBlock = node?.position?.start.line !== node?.position?.end.line ||
          (className?.startsWith('language-'));

        // Get the actual code content
        const codeContent = String(children).replace(/\n$/, '');

        if (isCodeBlock && className) {
          const language = className.replace('language-', '');
          if (language === 'mermaid') {
            return <MermaidDiagram code={codeContent} />;
          }
          if (language === 'chart') {
            return <ChartBlock spec={codeContent} />;
          }
          if (language === 'generative_ui') {
            return <GenerativeUIBlock code={codeContent} />;
          }
          if (language === 'spreadsheet') {
            return <SpreadsheetBlock spec={codeContent} />;
          }
          if (language === 'document') {
            return <DocumentBlock spec={codeContent} />;
          }
          return <CodeBlock language={language} code={codeContent} />;
        }

        // For inline code that doesn't have a language class
        if (!className && codeContent.includes('\n')) {
          return <CodeBlock language="" code={codeContent} />;
        }

        return (
          <InlineCode onOpenFile={handleOpenFile} onPreviewHtml={handlePreviewHtml}>
            {children}
          </InlineCode>
        );
      },

      // Override pre to just render children (CodeBlock handles the wrapper)
      pre({ children }) {
        return <>{children}</>;
      },

      // Tables
      table({ children }) {
        return (
          <div className="my-3 overflow-x-auto">
            <table className="min-w-full text-xs border-collapse">
              {children}
            </table>
          </div>
        );
      },
      thead({ children }) {
        return <thead className="bg-zinc-800">{children}</thead>;
      },
      th({ children, style }) {
        return (
          <th
            className="px-3 py-2 text-left font-semibold text-zinc-200 border border-zinc-700"
            style={style}
          >
            {children}
          </th>
        );
      },
      tbody({ children }) {
        return <tbody>{children}</tbody>;
      },
      tr({ children }) {
        return <tr className="even:bg-zinc-700/20 odd:bg-zinc-900/30">{children}</tr>;
      },
      td({ children, style }) {
        return (
          <td
            className="px-3 py-2 text-zinc-400 border border-zinc-700"
            style={style}
          >
            {children}
          </td>
        );
      },

      // Headings
      h1({ children }) {
        return <h1 className="text-xl font-bold text-zinc-200 mt-4 mb-2">{children}</h1>;
      },
      h2({ children }) {
        return <h2 className="text-lg font-bold text-zinc-200 mt-3 mb-2">{children}</h2>;
      },
      h3({ children }) {
        return <h3 className="text-base font-semibold text-zinc-200 mt-3 mb-1">{children}</h3>;
      },
      h4({ children }) {
        return <h4 className="text-sm font-semibold text-zinc-200 mt-2 mb-1">{children}</h4>;
      },
      h5({ children }) {
        return <h5 className="text-sm font-medium text-zinc-400 mt-2 mb-1">{children}</h5>;
      },
      h6({ children }) {
        return <h6 className="text-xs font-medium text-zinc-400 mt-2 mb-1">{children}</h6>;
      },

      // Paragraphs
      p({ children }) {
        return <p className="my-1">{children}</p>;
      },

      // Lists
      ul({ children }) {
        return <ul className="my-2 pl-5 space-y-1 list-disc">{children}</ul>;
      },
      ol({ children }) {
        return <ol className="my-2 pl-5 space-y-1 list-decimal">{children}</ol>;
      },
      li({ children }) {
        return <li className="text-zinc-400">{children}</li>;
      },

      // Blockquote
      blockquote({ children }) {
        return (
          <blockquote className="my-2 pl-4 border-l-2 border-primary-500/50 text-zinc-400 italic">
            {children}
          </blockquote>
        );
      },

      // Horizontal rule
      hr() {
        return <hr className="my-4 border-zinc-700" />;
      },

      // Links - with IACT protocol support for inline interactions
      a({ href, children }) {
        // IACT: [text](!send) — click to send text as user message
        if (href === '!send') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('iact:send', { detail: text }));
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 hover:text-primary-300 border border-primary-500/20 hover:border-primary-500/40 transition-all cursor-pointer text-sm font-medium"
              title="点击发送"
            >
              {children}
              <Send className="w-3 h-3 opacity-60" />
            </button>
          );
        }

        // IACT: [text](!add) — click to fill text into input box
        if (href === '!add') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('iact:add', { detail: text }));
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300 border border-amber-500/20 hover:border-amber-500/40 transition-all cursor-pointer text-sm font-medium"
              title="点击填入输入框"
            >
              {children}
              <PenLine className="w-3 h-3 opacity-60" />
            </button>
          );
        }

        // IACT: [command](!run) — click to execute shell command
        if (href === '!run') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('iact:run', { detail: text }));
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300 border border-emerald-500/20 hover:border-emerald-500/40 transition-all cursor-pointer text-sm font-medium font-mono"
              title="点击执行命令"
            >
              <Terminal className="w-3 h-3 opacity-60" />
              {children}
            </button>
          );
        }

        // IACT: [filepath](!open) — click to open file in editor/Finder
        if (href === '!open') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              onClick={() => {
                window.domainAPI?.invoke('workspace', 'openPath', { filePath: text });
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 border border-blue-500/20 hover:border-blue-500/40 transition-all cursor-pointer text-sm font-medium"
              title="打开文件"
            >
              <ExternalLink className="w-3 h-3 opacity-60" />
              {children}
            </button>
          );
        }

        // IACT: [filepath](!preview) — click to preview in PreviewPanel
        if (href === '!preview') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              onClick={() => {
                useAppStore.getState().openPreview(text);
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300 border border-violet-500/20 hover:border-violet-500/40 transition-all cursor-pointer text-sm font-medium"
              title="预览文件"
            >
              <Eye className="w-3 h-3 opacity-60" />
              {children}
            </button>
          );
        }

        // IACT: [text](!copy) — click to copy text to clipboard
        if (href === '!copy') {
          return (
            <IACTCopyButton>{children}</IACTCopyButton>
          );
        }

        // IACT: [ID](!ticket) — Jira-like ticket auto-link, click to copy ID
        if (href === '!ticket') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(text); }}
              className="text-sky-400 hover:text-sky-300 underline underline-offset-2 cursor-pointer font-mono text-[0.95em]"
              title={`点击复制 ${text}`}
            >
              {children}
            </button>
          );
        }

        // Raw URL（textNode === href）渲染为带 favicon 的预览 chip
        if (href && isRawUrlLink(href, children)) {
          return <LinkPreviewCard href={href} />;
        }

        // Regular links（带描述文字的内联链接）
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-400 hover:text-primary-300 underline underline-offset-2"
          >
            {children}
          </a>
        );
      },

      // Text formatting
      strong({ children }) {
        return <strong className="font-semibold text-zinc-200">{children}</strong>;
      },
      em({ children }) {
        return <em className="italic text-zinc-200">{children}</em>;
      },
      del({ children }) {
        return <del className="line-through text-zinc-500">{children}</del>;
      },

      // Images
      img({ src, alt }) {
        return (
          <img
            src={src}
            alt={alt || ''}
            className="max-w-full h-auto rounded-lg my-2"
            loading="lazy"
          />
        );
      },
    }),
    [handleOpenFile, handlePreviewHtml]
  );

  // Filter out system tags, auto-link ticket IDs, wrap file paths before rendering
  const filteredContent = useMemo(() => {
    const cleaned = filterSystemTags(content);
    const withTickets = wrapTicketsAsLinks(cleaned);
    return wrapFilePathsInBackticks(withTickets);
  }, [content]);

  return (
    <div className="text-sm leading-relaxed break-words prose prose-invert prose-sm max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {filteredContent}
      </ReactMarkdown>
    </div>
  );
});

// Re-export for backward compatibility
export { CodeBlock, InlineCode as InlineTextWithCode };
