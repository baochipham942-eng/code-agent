// ============================================================================
// MessageContent - Markdown rendering using react-markdown
// ============================================================================

import React, { useMemo, useCallback, memo, useEffect } from 'react';
import { Send, PenLine, Terminal, Eye, ExternalLink, Play } from 'lucide-react';
import remend from 'remend';
import type { Components } from 'react-markdown';
import type { MessageContentProps } from './types';
import { useAppStore } from '../../../../stores/appStore';
import { wrapFilePathsInBackticks, wrapTicketsAsLinks } from './filePathProcessor';
import { parseLeadingTriggerToken } from './triggerTokenHighlight';
import { isWebMode, copyPathToClipboard, openExternalLink } from '../../../../utils/platform';
import { ChartBlock, isChartSpecSource } from './ChartBlock';
import { LinkPreviewCard, isRawUrlLink } from './LinkPreviewCard';
import { GenerativeUIBlock } from './GenerativeUIBlock';
import { SpreadsheetBlock } from './SpreadsheetBlock';
import { DocumentBlock } from './DocumentBlock';
import { shouldRenderStreamingContentAsMarkdown, useThrottledStreamingContent } from '../../../../hooks/useThrottledStreamingContent';
import { recordStreamingPerformanceCounter } from '../../../../utils/streamingPerformanceMetrics';
import {
  MermaidDiagram,
  CodeBlock,
  InlineCode,
  IACTCopyButton,
  IACTNavCard,
  MarkdownMediaImage,
  MarkdownRenderer,
  filterSystemTags,
} from './messageContentParts';

/**
 * 把"本地 HTML 文件"的 href 解析成可预览的路径；非本地 HTML 返回 null。
 * - http/https 网页（即便以 .html 结尾）不拦，按真·外链处理。
 * - file:// 本地文件、绝对/家目录/相对路径，且以 .html/.htm 结尾 → 返回去掉 file:// 的路径。
 */
export function localHtmlHrefToPath(href: string | undefined): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return null;
  const path = href.replace(/^file:\/\//, '');
  return /\.html?(?:[?#].*)?$/i.test(path) ? path : null;
}

// Main message content component
export const MessageContent: React.FC<MessageContentProps> = memo(function MessageContent({ content, isUser, isStreaming = false, messageId, mediaContext }) {
  const openPreview = useAppStore((state) => state.openPreview);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const streamingNeedsMarkdown = !isUser && isStreaming && shouldRenderStreamingContentAsMarkdown(content);
  const markdownSource = useThrottledStreamingContent(content, streamingNeedsMarkdown);

  useEffect(() => {
    recordStreamingPerformanceCounter('stream.message_content.render');
    if (!isStreaming || isUser) return;
    recordStreamingPerformanceCounter(
      streamingNeedsMarkdown
        ? 'stream.message_content.streaming_markdown_render'
        : 'stream.message_content.streaming_plain_render',
    );
  });

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
          // 模型常把图表数据放进 ```json 而非 ```chart；内容若是合法图表 spec 就同样内联渲染
          if (language === 'json' && isChartSpecSource(codeContent)) {
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
          <div className="my-3 overflow-x-auto scrollbar-hidden">
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

        // IACT: [label](neo://...) — 应用内导航卡片
        if (href?.startsWith('neo://')) {
          return <IACTNavCard href={href}>{children}</IACTNavCard>;
        }

        // 本地 HTML 文件链接 → 走 in-app 产物预览（产物为主轴），而非外部打开。
        // 模型常把生成的 HTML 写成 [snake.html](file:///.../snake.html)；点这种链接应在
        // app 内以可玩产物展示，不是丢给系统浏览器。真·网页外链（http/https）不拦。
        const htmlPreviewPath = localHtmlHrefToPath(href);
        if (htmlPreviewPath) {
          return (
            <a
              href={href}
              onClick={(e) => { e.preventDefault(); handlePreviewHtml(htmlPreviewPath); }}
              className="inline-flex items-center gap-1 text-primary-300 hover:text-primary-200 underline underline-offset-2 cursor-pointer"
              title="点击预览"
            >
              {children}
              <Play className="w-3 h-3 opacity-60 text-blue-400" />
            </a>
          );
        }

        // Regular links（带描述文字的内联链接）
        // Tauri webview 里 <a target="_blank"> 不会触发任何打开，必须拦截 onClick 走系统 opener
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => { if (openExternalLink(href)) e.preventDefault(); }}
            className="text-primary-400 hover:text-primary-300 underline underline-offset-2 cursor-pointer"
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
          <MarkdownMediaImage
            src={src}
            alt={alt}
            messageId={messageId}
            mediaContext={mediaContext}
          />
        );
      },
    }),
    [handleOpenFile, handlePreviewHtml, mediaContext?.sessionId, mediaContext?.turnId, mediaContext?.messageId, messageId]
  );

  // Filter out system tags, auto-link ticket IDs, wrap file paths,
  // then close incomplete markdown tokens for streaming-safe rendering
  const filteredContent = useMemo(() => {
    const cleaned = filterSystemTags(markdownSource);
    const withTickets = wrapTicketsAsLinks(cleaned);
    const wrapped = wrapFilePathsInBackticks(withTickets);
    return remend(wrapped);
  }, [markdownSource]);

  // For user messages, render as plain text (no markdown processing)
  // 使用 span 而非 div，避免复制时末尾多出换行符
  if (isUser) {
    // 核心功能触发词（@neo / /goal / /workflow）上色，正文逐字符不变
    const trigger = parseLeadingTriggerToken(content);
    return (
      <span className="text-sm leading-relaxed whitespace-pre-wrap break-words block">
        {trigger ? (
          <>
            {trigger.prefix}
            <span className={trigger.className} data-testid={`trigger-token-${trigger.kind}`}>{trigger.token}</span>
            {trigger.rest}
          </>
        ) : content}
      </span>
    );
  }

  if (isStreaming && !streamingNeedsMarkdown) {
    return (
      <div className="text-sm leading-relaxed break-words prose prose-invert prose-sm max-w-none streaming-text with-caret">
        <span className="whitespace-pre-wrap">
          {filterSystemTags(content)}
        </span>
      </div>
    );
  }

  // 流式中的 markdown 内容才加揭示动画 + 内联呼吸光标；已完成消息不加（避免重播/常驻光标）
  const streamingDecor = isStreaming ? ' streaming-text with-caret' : '';
  return (
    <div className={`text-sm leading-relaxed break-words prose prose-invert prose-sm max-w-none${streamingDecor}`}>
      <MarkdownRenderer content={filteredContent} components={components} />
    </div>
  );
});

// Re-export for backward compatibility
export { CodeBlock, InlineCode as InlineTextWithCode };
