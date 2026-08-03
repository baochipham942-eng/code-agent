// ============================================================================
// MessageContent parts — module-private 子组件 / 纯函数 / 常量
// 从 MessageContent.tsx 纯结构性拆出，零行为改动；主组件按需 import 回去
// ============================================================================

import React, { useState, useMemo, useCallback, memo, useEffect, lazy, Suspense } from 'react';
import { Code2, Copy, Check, ExternalLink, ClipboardCopy, MessageSquare, MessageSquarePlus, Settings } from 'lucide-react';
import { UI } from '@shared/constants';
import type { Components } from 'react-markdown';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { SETTINGS_TAB_IDS, type SettingsTab } from '../../../../utils/settingsTabs';
import {
  recordStreamingPerformanceCounter,
  recordStreamingPerformanceTiming,
} from '../../../../utils/streamingPerformanceMetrics';
import {
  buildMarkdownMediaAsset,
  type SessionMediaContext,
} from '@shared/utils/sessionMediaAssets';
import {
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from './MediaAssetControls';

// react-markdown + katex/remark 插件家族(vendor-markdown/vendor-katex)与
// react-syntax-highlighter(Prism)按需动态加载,只在真正渲染消息正文/代码块时才下载,
// 移出首屏关键路径(同 mermaidLoader.ts 的设计动机)。
const LazyMarkdownCore = lazy(() => import('./MarkdownCore'));
const LazyPrismCodeBlock = lazy(() => import('./PrismCodeBlock'));

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
  yaml: { color: 'text-badge-danger', name: 'YAML' },
  yml: { color: 'text-badge-danger', name: 'YAML' },
  markdown: { color: 'text-zinc-400', name: 'Markdown' },
  md: { color: 'text-zinc-400', name: 'Markdown' },
  java: { color: 'text-badge-danger', name: 'Java' },
  c: { color: 'text-blue-300', name: 'C' },
  cpp: { color: 'text-blue-300', name: 'C++' },
  csharp: { color: 'text-purple-400', name: 'C#' },
  cs: { color: 'text-purple-400', name: 'C#' },
  php: { color: 'text-indigo-400', name: 'PHP' },
  ruby: { color: 'text-badge-danger', name: 'Ruby' },
  rb: { color: 'text-badge-danger', name: 'Ruby' },
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
  neo_ui: { color: 'text-violet-300', name: 'Neo Interactive UI' },
};

// MermaidDiagram 及其缩放/标注/高度缓存已拆到独立文件（大文件门），原有消费者从这里 re-export
export {
  MermaidDiagram,
  findMermaidSelectable,
  clampMermaidScale,
  zoomMermaidViewAt,
  mermaidWheelZoomFactor,
  rememberMermaidHeight,
  getCachedMermaidHeight,
  type MermaidView,
} from './MermaidDiagram';

// Threshold for collapsible code blocks
const CODE_COLLAPSE_LINES = 25;
const CODE_PROGRESSIVE_HIGHLIGHT_LINES = 30;

const codeBlockStyle = {
  margin: 0,
  padding: '1rem',
  background: 'transparent',
  fontSize: '0.75rem',
  lineHeight: '1.25rem',
  overflowY: 'visible',
} as const;

const codeLineNumberStyle = {
  minWidth: '2.5em',
  paddingRight: '1em',
  // 语义 token:dark 下等同原 rgb(113 113 122),light 下换深色保持可读
  color: 'var(--text-tertiary)',
  userSelect: 'none',
} as const;

function getScheduleFrame(): {
  requestFrame: (callback: FrameRequestCallback) => number | ReturnType<typeof globalThis.setTimeout>;
  cancelFrame: (id: number | ReturnType<typeof globalThis.setTimeout>) => void;
} {
  const hasAnimationFrame = typeof window !== 'undefined'
    && typeof window.requestAnimationFrame === 'function'
    && typeof window.cancelAnimationFrame === 'function';

  if (hasAnimationFrame) {
    return {
      requestFrame: window.requestAnimationFrame.bind(window),
      cancelFrame: window.cancelAnimationFrame.bind(window) as (id: number | ReturnType<typeof globalThis.setTimeout>) => void,
    };
  }

  return {
    requestFrame: (callback) => globalThis.setTimeout(() => callback(Date.now()), 16),
    cancelFrame: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  };
}

const PlainCodeLines = memo(function PlainCodeLines({
  lines,
  showLineNumbers,
  startLineNumber,
  wrapLines,
}: {
  lines: string[];
  showLineNumbers: boolean;
  startLineNumber: number;
  wrapLines: boolean;
}) {
  return (
    <pre
      className="scrollbar-hidden overflow-x-auto p-4 text-xs leading-5 text-zinc-200"
      data-code-preview="plain"
      style={{
        margin: 0,
        background: 'transparent',
      }}
    >
      <code className="block font-mono">
        {lines.map((line, index) => (
          <span className="table-row" key={index}>
            {showLineNumbers && (
              <span className="table-cell min-w-10 select-none pr-4 text-right text-zinc-600">
                {startLineNumber + index}
              </span>
            )}
            <span className={`table-cell ${wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
              {line}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
});

interface CodeLineChunk {
  startIndex: number;
  code: string;
  lineCount: number;
}

function chunkLines(lines: string[], chunkSize: number): CodeLineChunk[] {
  const chunks: CodeLineChunk[] = [];
  for (let startIndex = 0; startIndex < lines.length; startIndex += chunkSize) {
    const chunk = lines.slice(startIndex, startIndex + chunkSize);
    chunks.push({
      startIndex,
      code: chunk.join('\n'),
      lineCount: chunk.length,
    });
  }
  return chunks;
}

const HighlightedCodeChunk = memo(function HighlightedCodeChunk({
  chunk,
  language,
  showLineNumbers,
  wrapLines,
}: {
  chunk: CodeLineChunk;
  language: string;
  showLineNumbers: boolean;
  wrapLines: boolean;
}) {
  return (
    <Suspense
      fallback={
        <PlainCodeLines
          lines={chunk.code.split('\n')}
          showLineNumbers={showLineNumbers}
          startLineNumber={chunk.startIndex + 1}
          wrapLines={wrapLines}
        />
      }
    >
      <LazyPrismCodeBlock
        className="scrollbar-hidden"
        language={language || 'text'}
        showLineNumbers={showLineNumbers}
        startingLineNumber={chunk.startIndex + 1}
        customStyle={codeBlockStyle}
        lineNumberStyle={codeLineNumberStyle}
        wrapLongLines={wrapLines}
        code={chunk.code}
      />
    </Suspense>
  );
}, (prev, next) => (
  prev.chunk === next.chunk
  && prev.language === next.language
  && prev.showLineNumbers === next.showLineNumbers
  && prev.wrapLines === next.wrapLines
));

// Code block with copy button and syntax highlighting
export const CodeBlock = memo(function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const renderStartedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const config = languageConfig[language] || { color: 'text-zinc-400', name: language || 'code' };
  const lines = useMemo(() => code.split('\n'), [code]);
  const lineChunks = useMemo(
    () => chunkLines(lines, CODE_PROGRESSIVE_HIGHLIGHT_LINES),
    [lines],
  );
  const showLineNumbers = lines.length > 3;
  const isLong = lines.length > CODE_COLLAPSE_LINES;
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsed, setCollapsed] = useState(() => isLong);
  const [highlightedChunkCount, setHighlightedChunkCount] = useState(() => (
    isLong ? 0 : lineChunks.length
  ));
  const highlightedLineCount = collapsed
    ? 0
    : Math.min(
        lineChunks.slice(0, highlightedChunkCount).reduce((sum, chunk) => sum + chunk.lineCount, 0),
        lines.length,
      );

  // 仅在初次 mount 时按长度折叠（见上方 useState 初始化），不再在流式过程中
  // 因跨过阈值而强制塌陷——否则用户正在阅读的代码块会在生成中途突然折叠、布局跳变。

  useEffect(() => {
    if (collapsed) {
      setHighlightedChunkCount(0);
      return;
    }
    if (!isLong) {
      setHighlightedChunkCount(lineChunks.length);
      return;
    }

    let cancelled = false;
    let frameId: number | ReturnType<typeof globalThis.setTimeout> | null = null;
    const { requestFrame, cancelFrame } = getScheduleFrame();
    setHighlightedChunkCount(0);

    const scheduleNextChunk = () => {
      frameId = requestFrame(() => {
        if (cancelled) return;
        setHighlightedChunkCount((current) => {
          const next = Math.min(current + 1, lineChunks.length);
          if (next < lineChunks.length) {
            scheduleNextChunk();
          }
          return next;
        });
      });
    };

    scheduleNextChunk();

    return () => {
      cancelled = true;
      if (frameId !== null) cancelFrame(frameId);
    };
  }, [collapsed, isLong, lineChunks.length]);

  useEffect(() => {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    recordStreamingPerformanceTiming(
      collapsed ? 'stream.code.preview_ms' : 'stream.code.highlight_ms',
      now - renderStartedAt,
    );
  }, [collapsed, renderStartedAt]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  const displayCode = collapsed ? lines.slice(0, CODE_COLLAPSE_LINES).join('\n') : code;
  const displayLines = collapsed ? displayCode.split('\n') : [];
  const remainingPlainLines = !collapsed && isLong ? lines.slice(highlightedLineCount) : [];
  const highlightedLineChunks = !collapsed && isLong
    ? lineChunks.slice(0, highlightedChunkCount)
    : [];
  const isHighlightComplete = !isLong || collapsed || highlightedLineCount >= lines.length;

  return (
    <div
      className="my-3 rounded-xl bg-[var(--code-bg)] overflow-hidden border border-zinc-700 shadow-lg"
      data-code-block-lines={lines.length}
      data-code-highlighted-lines={collapsed ? 0 : highlightedLineCount}
      data-code-highlight-complete={isHighlightComplete ? 'true' : 'false'}
    >
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
        {collapsed ? (
          <PlainCodeLines
            lines={displayLines}
            showLineNumbers={showLineNumbers}
            startLineNumber={1}
            wrapLines={wrapLines}
          />
        ) : isLong ? (
          <>
            {highlightedLineChunks.map((chunk) => (
              <HighlightedCodeChunk
                key={chunk.startIndex}
                chunk={chunk}
                language={language}
                showLineNumbers={showLineNumbers}
                wrapLines={wrapLines}
              />
            ))}
            {remainingPlainLines.length > 0 && (
              <PlainCodeLines
                lines={remainingPlainLines}
                showLineNumbers={showLineNumbers}
                startLineNumber={highlightedLineCount + 1}
                wrapLines={wrapLines}
              />
            )}
          </>
        ) : (
          <Suspense
            fallback={
              <PlainCodeLines
                lines={lines}
                showLineNumbers={showLineNumbers}
                startLineNumber={1}
                wrapLines={wrapLines}
              />
            }
          >
            <LazyPrismCodeBlock
              className="scrollbar-hidden"
              language={language || 'text'}
              showLineNumbers={showLineNumbers}
              customStyle={codeBlockStyle}
              lineNumberStyle={codeLineNumberStyle}
              wrapLongLines={wrapLines}
              code={displayCode}
            />
          </Suspense>
        )}
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
// Also supports :lineNumber suffix (e.g., src/host/agent.ts:42)
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
  if (segments.length === 1 && /^[\w][\w.-]*\.\w+$/.test(pathWithoutLine)) {
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
export const InlineCode = memo(function InlineCode({
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

  // Regular inline code (not a file) — 轻呈现：6% 白淡底、小圆角，无边框无实心块感
  if (!isFile) {
    return (
      <code className="px-1 mx-0.5 rounded bg-white/[0.06] text-zinc-200 text-xs font-mono">
        {children}
      </code>
    );
  }

  // File path - 可点，但去 chip 容器感：mono 蓝字 inline 在正文流里，
  // hover 出下划线 + ↗ 表达可点；点击进 app 内预览，不再直接打开本地文件。
  const { path: filePath, lineNumber } = parseFilePathWithLine(text);

  return (
    <code
      className="inline-flex items-baseline gap-0.5 mx-0.5 font-mono text-xs text-primary-300 hover:text-primary-200 cursor-pointer hover:underline underline-offset-2 transition-colors group"
      onClick={() => {
        if (isHtml && onPreviewHtml) {
          onPreviewHtml(filePath);
        } else if (onOpenFile) {
          onOpenFile(filePath, lineNumber);
        }
      }}
      title={isHtml ? '点击预览' : lineNumber ? `点击预览（第 ${lineNumber} 行）` : '点击预览'}
    >
      {children}
      <ExternalLink className="w-3 h-3 self-center opacity-0 group-hover:opacity-60 transition-opacity" />
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
  // 过滤 think 标签（模型推理过程不应显示给用户）。
  // 未闭合的 <think>（流式异常截断等）没有 </think> 可匹配——只删标签本身会把
  // 整段推理原文原样留在正文里、绕过思考折叠机制摊在转录里。兜底：把 <think> 到
  // 字符串结尾的全部内容都当推理一并删掉（宿主层 sseStream.ts 已修复不再产出这种
  // 数据，这里是渲染层兜底，防历史脏数据 / 未知泄漏路径）。
  /<think>[\s\S]*?<\/think>/g,
  /<\/think>/g,
  /<think>[\s\S]*$/g,
  // 过滤 skill 加载状态标签（应由 SkillStatusMessage 组件渲染，此处作为兜底）
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
];

/**
 * Filter out system-injected tags that shouldn't be shown to users
 */
export function filterSystemTags(text: string): string {
  let filtered = text;
  for (const pattern of SYSTEM_TAG_PATTERNS) {
    filtered = filtered.replace(pattern, '');
  }
  // Clean up multiple consecutive newlines left by removed tags
  filtered = filtered.replace(/\n{3,}/g, '\n\n');
  return filtered.trim();
}

/**
 * 已知 HTML 标签名单：只剥这些，避免误伤技术文本里的尖括号（如 Array<string>、a<b）。
 */
const RAW_HTML_TAG_PATTERN = /<\/?(?:span|div|p|br|hr|b|i|em|strong|u|s|del|ins|mark|small|sub|sup|a|img|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|section|article|header|footer|nav|aside|main|figure|figcaption|button|input|select|option|textarea|label|form|style|script|font|center|details|summary|kbd|samp|var|abbr|cite|q|blockquote)(?:\s[^>]*)?\/?>/gi;

/**
 * 纯文本兜底通道（流式中途的 plain-text 渲染、MarkdownCore 懒加载 fallback）没有
 * markdown/HTML 解析能力，模型偶尔输出的原始 HTML 标签（如 <span style=...>）和
 * IACT 链接语法（[text](!add)）会被原样露出。这里做降级清洗：
 * - IACT 链接降级为链接文字（协议在纯文本下不可点击，露出 "!add" 只会困惑）；
 * - HTML 标签剥掉只留内部文本（与 react-markdown 默认丢弃 html 节点的行为对齐）。
 */
export function sanitizePlainTextFallback(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(![^)]*\)/g, '$1')
    .replace(RAW_HTML_TAG_PATTERN, '');
}

/**
 * 完成态消息兜底：历史/上游数据里 HTML 标签可能被转义成字面文本持久化（QA 2026-07-28
 * A3 现象1：正文原样露出 `<span style="color:red">❌执行失败</span>`），react-markdown
 * 只能丢原始 html 节点，对已经是纯文本的标签无能为力。这里在 markdown 渲染前把代码
 * （fenced block / inline code）之外的已知 HTML 标签剥掉，只留内部文本。
 */
export function stripRawHtmlOutsideCode(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(RAW_HTML_TAG_PATTERN, '')))
    .join('');
}

// IACT Copy button with copied state feedback
export const IACTCopyButton: React.FC<{ children: React.ReactNode }> = ({ children }) => {
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

// IACT: [label](neo://...) — 应用内导航卡片（开/切会话、新建会话、跳设置 Tab）
export const IACTNavCard: React.FC<{ href: string; children: React.ReactNode }> = ({ children, href }) => {
  const rest = href.slice('neo://'.length);
  const [head, ...tail] = rest.split('/');
  const arg = tail.join('/');

  let onClick: (() => void) | null = null;
  let Icon = MessageSquare;
  let title = '';

  if (head === 'thread') {
    if (arg === '' || arg === 'new') {
      Icon = MessageSquarePlus;
      title = '新建会话';
      onClick = () => { void useSessionStore.getState().createSession(); };
    } else {
      Icon = MessageSquare;
      title = '打开会话';
      onClick = () => { void useSessionStore.getState().switchSession(arg); };
    }
  } else if (head === 'settings' && (SETTINGS_TAB_IDS as readonly string[]).includes(arg)) {
    Icon = Settings;
    title = '打开设置';
    onClick = () => { useAppStore.getState().openSettingsTab(arg as SettingsTab); };
  }

  // 未识别的 neo:// 链接 → 退化为纯文本，不渲染破卡片
  if (!onClick) {
    return <span>{children}</span>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-sky-500/10 text-badge-info hover:bg-sky-500/20 hover:text-badge-info border border-badge-info/20 hover:border-badge-info/40 transition-all cursor-pointer text-sm font-medium"
      title={title}
    >
      <Icon className="w-3 h-3 opacity-60" />
      {children}
    </button>
  );
};

// neo:// 是自定义 scheme，react-markdown 默认 urlTransform 白名单仅 http/https/mailto/xmpp，
// 会把 neo:// 剥成空 href 导致卡片不渲染；放行 neo://，其余仍走默认净化（实现见 MarkdownCore）。
const NEO_URL_SCHEMES = ['neo://'];

export const MarkdownRenderer = memo(function markdownRenderer({
  content,
  components,
}: {
  content: string;
  components: Components;
}) {
  const renderStartedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  useEffect(() => {
    recordStreamingPerformanceCounter('stream.markdown.render');
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    recordStreamingPerformanceTiming('stream.markdown.render_ms', now - renderStartedAt);
  });

  return (
    <Suspense fallback={<div className="whitespace-pre-wrap break-words">{sanitizePlainTextFallback(content)}</div>}>
      <LazyMarkdownCore
        content={content}
        gfm
        math
        breaks
        allowSchemes={NEO_URL_SCHEMES}
        components={components}
      />
    </Suspense>
  );
});

/**
 * markdown 渲染器按 CommonMark 规范会把图片 URL 里的非 ASCII 百分号编码一次。
 * 这个已编码的串如果被直接当成**文件路径**存进 asset.path，后面 resolveFileUrl 的
 * URLSearchParams 会再编码一次；服务器只解一次，拿到的是字面量 `%E4%B8%AD…`
 * 当文件名 → fs.stat 找不到 → 404。英文名没东西可编码，所以只有中文/日文/空格/emoji
 * 文件名会中招，长期没被发现。影响也不止显示：asset.path 同时供
 * 「修改 / 复制引用 / Finder」使用，中文名的图这三个动作也全是错路径。
 *
 * 在这里解码而不是在 buildMarkdownMediaAsset 里解：那个函数还被
 * markdownImageAssets() 用正则扫原文调用，那一路拿到的 src 本来就没编码，
 * 统一解码会把两种来源混在一起。只有这里能确定「来自渲染器 ⇒ 必然编码过」。
 *
 * data:/http(s): 原样返回——它们的百分号编码是 URL 语义的一部分，解了反而错。
 * 解码失败（文件名里有裸 `%`，如 `50%off.png`）时回退原串，不抛。
 */
export function decodeMarkdownImagePath(src: string | undefined): string | undefined {
  if (!src) return src;
  if (/^(data:|https?:|blob:)/i.test(src)) return src;
  try {
    const decoded = decodeURIComponent(src);
    return decoded === src ? src : decoded;
  } catch {
    // 裸 % 不是合法转义序列，decodeURIComponent 会抛——这类文件名保持原样
    return src;
  }
}

export const MarkdownMediaImage = memo(function MarkdownMediaImage({
  src,
  alt,
  messageId,
  mediaContext,
}: {
  src?: string;
  alt?: string;
  messageId?: string;
  mediaContext?: SessionMediaContext;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // 渲染器给的 src 是编码态；当文件路径用之前必须解回来（见 decodeMarkdownImagePath 注释）
  const decodedSrc = useMemo(() => decodeMarkdownImagePath(src), [src]);
  const asset = useMemo(
    () => buildMarkdownMediaAsset(decodedSrc, alt, {
      ...mediaContext,
      messageId: mediaContext?.messageId || messageId,
    }),
    [decodedSrc, alt, mediaContext?.sessionId, mediaContext?.turnId, mediaContext?.messageId, messageId],
  );

  if (!asset) {
    return (
      <img
        src={src}
        alt={alt || ''}
        className="max-w-full h-auto rounded-lg my-2"
        loading="lazy"
      />
    );
  }

  const renderSrc = getRenderableMediaSrc(asset);
  if (!renderSrc) {
    return (
      <span className="my-2 inline-block max-w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60 align-top">
        <span className="block px-3 py-2 text-xs text-zinc-500">
          图片过大，已跳过内联预览
        </span>
        <span className="flex items-center justify-end border-t border-zinc-800 bg-zinc-950/70 px-2 py-1">
          <MediaAssetActionBar asset={asset} compact />
        </span>
      </span>
    );
  }

  return (
    // group：操作条默认淡出，hover 这张图（整张卡片）才浮现（2026-08-02 产品负责人拍板）。
    <span className="group my-2 inline-block max-w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60 align-top">
      <button
        type="button"
        className="block max-w-full cursor-zoom-in bg-transparent p-0"
        onClick={() => setLightboxOpen(true)}
        title="放大查看"
      >
        <img
          src={renderSrc}
          alt={alt || ''}
          className="max-h-[420px] max-w-full object-contain"
          loading="lazy"
        />
      </button>
      {/* 只淡透明度、不改布局——否则 hover 时整段正文会跳。三个兜底缺一不可：
          ① focus-within：键盘 Tab 进来时必须看得见，否则键盘用户永远够不到这些动作；
          ② 触屏恒显（.media-actions-hover-reveal，规则写在 global.css）——那类设备根本没有 hover 态。
          ③ 条目本身不 aria-hidden，只是视觉淡出，读屏仍可达。 */}
      <span className="flex items-center justify-end border-t border-zinc-800 bg-zinc-950/70 px-2 py-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 media-actions-hover-reveal">
        <MediaAssetActionBar
          asset={asset}
          compact
          onOpenLightbox={() => setLightboxOpen(true)}
        />
      </span>
      {lightboxOpen && (
        <MediaAssetLightbox
          asset={asset}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </span>
  );
});
