// ============================================================================
// MessageContent - Markdown rendering using react-markdown
// ============================================================================

import React, { useMemo, useCallback, memo, useEffect } from 'react';
import { Send, PenLine, Terminal, Eye, ExternalLink, Play } from 'lucide-react';
import remend from 'remend';
import type { Components } from 'react-markdown';
import type { MessageContentProps } from './types';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { wrapFilePathsInBackticks, wrapTicketsAsLinks } from './filePathProcessor';
import { parseLeadingTriggerToken } from './triggerTokenHighlight';
import { isWebMode, copyPathToClipboard, openExternalLink } from '../../../../utils/platform';
import { isPreviewable } from '../../../../utils/previewable';
import { LinkPreviewCard, isRawUrlLink } from './LinkPreviewCard';
import { openHttpLinkInRail } from '../../../../services/userBrowserLink';
import { ChartBlock, isChartSpecSource } from './ChartBlock';
import { GenerativeUIBlock } from './GenerativeUIBlock';
import { GenerativeUIHost } from '../GenerativeUI/GenerativeUIHost';
import { neoUIOrdinalAtOffset } from '../GenerativeUI/sourceOrdinal';
import { generativeUiOrdinalAtOffset } from '@shared/generativeUIEdit';
import { SpreadsheetBlock } from './SpreadsheetBlock';
import { DocumentBlock } from './DocumentBlock';
import { shouldRenderStreamingContentAsMarkdown, useThrottledStreamingContent } from '../../../../hooks/useThrottledStreamingContent';
import { recordStreamingPerformanceCounter } from '../../../../utils/streamingPerformanceMetrics';
import {
  deferredTurnContentStyle,
  shouldDeferTurnContentLayout,
} from '../../../../utils/turnContentVisibility';
import {
  MermaidDiagram,
  CodeBlock,
  InlineCode,
  IACTCopyButton,
  IACTNavCard,
  MarkdownMediaImage,
  MarkdownRenderer,
  filterSystemTags,
  sanitizePlainTextFallback,
  stripRawHtmlOutsideCode,
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

// ============================================================================
// IACT !send chip 渲染（2026-08-02 拍板 B+A 组合，设计稿 neo-iact-chip-design.html）：
// 链接语义不穿按钮外观——单个 !send 是句中轻链接（A：品牌青字 + dotted 下划线，
// 无边框无底衬，hover 才出底衬/实线/尾部 Send 图标）；同段 ≥2 个 !send 时选项
// 摘出句外（B：正文降级为纯文本，段后渲染 ghost 选项行，与 DecisionCard 同构、
// 首项品牌青）。点击行为不变：统一 dispatch iact:send，发送链路
// （ChatInput + iactChipConfirmation 模板）不动。
// ============================================================================

function dispatchIactSend(text: string) {
  window.dispatchEvent(new CustomEvent('iact:send', { detail: text }));
}

/**
 * 提取段落 children 里 !send 链接的文案；非 !send 链接返回 null。
 * 注意：p 层拿到的 children 是「未求值」的链接元素（type 为自定义 a renderer，
 * props 是 { href, children }），不是 a renderer 返回的 button——因此按 href 识别；
 * DOM 侧另有 data-iact-send 标记（button 上）供测试/排查。
 */
function iactSendTextOf(node: React.ReactNode): string | null {
  if (!React.isValidElement(node)) return null;
  const props = node.props as { href?: unknown; children?: React.ReactNode };
  if (props.href !== '!send') return null;
  const c = props.children;
  return typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : '')).join('')
    : String(c ?? '');
}

// Main message content component
export const MessageContent: React.FC<MessageContentProps> = memo(function MessageContent({ content, isUser, isStreaming = false, messageId, mediaContext }) {
  const openPreview = useAppStore((state) => state.openPreview);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const streamingNeedsMarkdown = !isUser && isStreaming && shouldRenderStreamingContentAsMarkdown(content);
  const markdownSource = useThrottledStreamingContent(content, streamingNeedsMarkdown);
  const deferCompletedLayout = shouldDeferTurnContentLayout({
    content,
    isStreaming,
    isUser: Boolean(isUser),
  });

  useEffect(() => {
    recordStreamingPerformanceCounter('stream.message_content.render');
    if (!isStreaming || isUser) return;
    recordStreamingPerformanceCounter(
      streamingNeedsMarkdown
        ? 'stream.message_content.streaming_markdown_render'
        : 'stream.message_content.streaming_plain_render',
    );
  });

  // 点击文件链接进 app 内预览（PreviewPanel），不再直接打开本地文件；
  // 裸文件名（模型很少写全路径）先按名字在工作目录里找回真实路径；
  // 类型不支持预览时才回退系统打开（桌面）/ 复制路径（web）。
  const handleOpenFile = useCallback(async (filePath: string, lineNumber?: number) => {
    try {
      // Resolve relative paths
      let fullPath = filePath;
      if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
        fullPath = workingDirectory ? `${workingDirectory}/${filePath}` : filePath;
        // 裸文件名（无目录段）：workingDirectory 直拼基本必错，按名字找回真实路径
        if (workingDirectory && !filePath.includes('/')) {
          try {
            const response = await window.domainAPI?.invoke<Array<{ path: string }>>(
              'workspace', 'findFile', { dirPath: workingDirectory, name: filePath },
            );
            const found = response?.success && response.data?.length ? response.data[0] : null;
            if (found) fullPath = found.path;
          } catch { /* 找回失败就用直拼路径，交给预览层报错 */ }
        }
      }
      if (isPreviewable(fullPath)) {
        openPreview(fullPath);
        return;
      }
      if (isWebMode()) {
        await copyPathToClipboard(fullPath);
        return;
      }
      await window.domainAPI?.invoke('workspace', 'openPath', { filePath: fullPath, lineNumber });
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  }, [workingDirectory, openPreview]);

  // Handle previewing HTML in-app
  const handlePreviewHtml = useCallback((filePath: string) => {
    // Resolve relative paths
    let fullPath = filePath;
    if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
      fullPath = workingDirectory ? `${workingDirectory}/${filePath}` : filePath;
    }
    openPreview(fullPath);
  }, [openPreview, workingDirectory]);

  const handleOpenHttpLink = useCallback((href: string) => openHttpLinkInRail({
    href,
    conversationId: mediaContext?.sessionId || currentSessionId,
    workspace: workingDirectory,
  }), [currentSessionId, mediaContext?.sessionId, workingDirectory]);

  // Filter out system tags, auto-link ticket IDs, wrap file paths,
  // then close incomplete markdown tokens for streaming-safe rendering
  const filteredContent = useMemo(() => {
    const cleaned = filterSystemTags(markdownSource);
    const noRawHtml = stripRawHtmlOutsideCode(cleaned);
    const withTickets = wrapTicketsAsLinks(noRawHtml);
    const wrapped = wrapFilePathsInBackticks(withTickets);
    return remend(wrapped);
  }, [markdownSource]);

  // Custom components for react-markdown
  const components: Components = useMemo(
    () => ({
      // Code blocks and inline code
      code({ node, className, children }) {
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
            return (
              <GenerativeUIBlock
                code={codeContent}
                messageId={messageId}
                sessionId={mediaContext?.sessionId}
                sourceOrdinal={generativeUiOrdinalAtOffset(filteredContent, node?.position?.start.offset)}
                isStreaming={isStreaming}
              />
            );
          }
          if (language === 'neo_ui') {
            return (
              <GenerativeUIHost
                rawSpec={codeContent}
                sessionId={mediaContext?.sessionId}
                messageId={messageId}
                sourceOrdinal={neoUIOrdinalAtOffset(filteredContent, node?.position?.start.offset)}
                isStreaming={isStreaming}
              />
            );
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
      // 轻呈现表格：thead 无亮底（11px 小字灰）、无竖向边框、只留横向行分隔线、无斑马纹
      thead({ children }) {
        return <thead>{children}</thead>;
      },
      th({ children, style }) {
        return (
          <th
            className="px-2 py-1.5 text-left text-[11px] font-medium text-zinc-500"
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
        return <tr className="border-b border-zinc-800">{children}</tr>;
      },
      td({ children, style }) {
        return (
          <td
            className="px-2 py-1.5 text-zinc-400"
            style={style}
          >
            {children}
          </td>
        );
      },

      // 会话内标题压平：H1-H3 统一 13.5px semibold，只用 margin 分层，不给更大字号/更亮颜色
      h1({ children }) {
        return <h1 className="text-[13.5px] font-semibold text-zinc-200 mt-3.5 mb-1.5">{children}</h1>;
      },
      h2({ children }) {
        return <h2 className="text-[13.5px] font-semibold text-zinc-200 mt-3.5 mb-1.5">{children}</h2>;
      },
      h3({ children }) {
        return <h3 className="text-[13.5px] font-semibold text-zinc-200 mt-3.5 mb-1.5">{children}</h3>;
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

      // Paragraphs：同段 ≥2 个完整 !send 链接时摘出为段后选项行（B，2026-08-02 拍板）。
      // 流式中途未写完的链接经 remend 兜底后 href 不是 !send，不会带标记，
      // 因此选项行只在 ≥2 个链接完整出现后才出现——不提前、不闪烁；
      // 跨段落各 1 个时互不影响，各自仍是句中轻链接（A）。
      p({ children }) {
        const nodes = React.Children.toArray(children);
        const chipTexts = nodes.map(iactSendTextOf);
        const optionTexts = chipTexts.filter((t): t is string => t !== null);
        if (optionTexts.length < 2) {
          return <p className="my-2.5">{children}</p>;
        }
        // 正文里的 chip 降级为纯文本，句子恢复干净；选项摘到段后成行。
        const cleanNodes = nodes.map((node, i) =>
          chipTexts[i] !== null
            ? <React.Fragment key={(node as React.ReactElement).key ?? i}>{chipTexts[i]}</React.Fragment>
            : node,
        );
        return (
          <>
            <p className="my-2.5">{cleanNodes}</p>
            <div className="mt-2 flex flex-wrap gap-2" data-iact-options="">
              {optionTexts.map((text, i) => (
                <button /* ds-allow:button: IACT 选项行 ghost 按钮，与 DecisionCard 选项行同构 */
                  key={`${i}-${text}`}
                  type="button"
                  onClick={() => dispatchIactSend(text)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border text-[12.5px] transition-colors cursor-pointer ${
                    i === 0
                      ? 'border-primary-500/35 bg-zinc-800/50 text-primary-400 hover:bg-primary-500/10'
                      : 'border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:border-primary-500/50 hover:text-primary-400 hover:bg-primary-500/10'
                  }`}
                >
                  {text}
                  <Send className="w-3 h-3 opacity-50" />
                </button>
              ))}
            </div>
          </>
        );
      },

      // Lists
      ul({ children }) {
        return <ul className="my-2 pl-5 space-y-1 list-disc marker:text-zinc-600">{children}</ul>;
      },
      ol({ children }) {
        return <ol className="my-2 pl-5 space-y-1 list-decimal marker:text-zinc-600">{children}</ol>;
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
        // 2026-08-02 拍板：轻链接形态（A）——品牌青字 + dotted 下划线，无边框无底衬；
        // hover 才出底衬/实线/尾部 Send 图标（非 hover 时 opacity 0，空间预留不抖动）。
        // data-iact-send 是 DOM 侧识别标记（测试/排查用）；p 层分组（B）按 href 扫描，
        // 同段 ≥2 个时会被摘出为选项行。
        if (href === '!send') {
          const text = typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(c => typeof c === 'string' ? c : '').join('')
            : String(children ?? '');
          return (
            <button
              type="button"
              data-iact-send={text}
              onClick={() => dispatchIactSend(text)}
              className="group inline-flex items-center gap-0.5 px-0.5 rounded text-primary-400 font-medium underline decoration-dotted decoration-[rgba(45,212,191,0.45)] underline-offset-4 hover:bg-primary-500/10 hover:decoration-solid transition-colors cursor-pointer"
              title="点击发送"
            >
              {children}
              <Send className="w-[11px] h-[11px] opacity-0 group-hover:opacity-[0.55] transition-opacity" />
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

        // raw URL（链接文字就是 URL 本身）：favicon + 下划线链接，帮用户一眼认站点。
        // 轻呈现——只有 16px 图标，没有 chip 边框/底色。
        if (href && isRawUrlLink(href, children)) {
          return <LinkPreviewCard href={href} onOpen={handleOpenHttpLink} />;
        }

        // Regular links（带描述文字的内联链接）
        // Tauri webview 里 <a target="_blank"> 不会触发任何打开，必须拦截 onClick 走系统 opener
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if ((href && handleOpenHttpLink(href)) || openExternalLink(href)) e.preventDefault();
            }}
            className="text-primary-400 hover:text-primary-300 underline underline-offset-2 cursor-pointer"
          >
            {children}
          </a>
        );
      },

      // Text formatting
      // strong 只给字重不提色：颜色继承所在正文（text-inherit），任何容器下都与正文同色
      strong({ children }) {
        return <strong className="font-semibold text-inherit">{children}</strong>;
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
    [filteredContent, handleOpenFile, handleOpenHttpLink, handlePreviewHtml, isStreaming, mediaContext?.sessionId, mediaContext?.turnId, mediaContext?.messageId, messageId]
  );

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
      <div className="text-sm leading-[1.7] break-words prose prose-invert prose-sm max-w-none streaming-text with-caret">
        <span className="whitespace-pre-wrap">
          {sanitizePlainTextFallback(filterSystemTags(content))}
        </span>
      </div>
    );
  }

  // 流式中的 markdown 内容才加揭示动画 + 内联呼吸光标；已完成消息不加（避免重播/常驻光标）
  const streamingDecor = isStreaming ? ' streaming-text with-caret' : '';
  return (
    <div
      className={`text-sm leading-[1.7] break-words prose prose-invert prose-sm max-w-none${streamingDecor}`}
      data-turn-heavy-content={deferCompletedLayout ? 'true' : undefined}
      style={deferCompletedLayout ? deferredTurnContentStyle : undefined}
    >
      <MarkdownRenderer content={filteredContent} components={components} />
    </div>
  );
});

// Re-export for backward compatibility
export { CodeBlock, InlineCode as InlineTextWithCode };
