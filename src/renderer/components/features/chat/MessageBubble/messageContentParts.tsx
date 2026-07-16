// ============================================================================
// MessageContent parts — module-private 子组件 / 纯函数 / 常量
// 从 MessageContent.tsx 纯结构性拆出，零行为改动；主组件按需 import 回去
// ============================================================================

import React, { useState, useMemo, useCallback, memo, useRef, useEffect } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Code2, Copy, Check, ExternalLink, Play, ZoomIn, ZoomOut, Eye, ClipboardCopy, MessageSquare, MessageSquarePlus, Settings } from 'lucide-react';
import { loadMermaid } from './mermaidLoader';
import { UI } from '@shared/constants';
import 'katex/dist/katex.min.css';
import type { Components } from 'react-markdown';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useMessageActionStore } from '../../../../stores/messageActionStore';
import { useI18n } from '../../../../hooks/useI18n';
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
  neo_ui: { color: 'text-violet-300', name: 'Neo Interactive UI' },
};

// Unique ID counter for mermaid diagrams
let mermaidIdCounter = 0;

const MERMAID_MIN_SCALE = 0.1;
const MERMAID_MAX_SCALE = 4;
const MERMAID_VIEWPORT_MAX_HEIGHT = 560;
const MERMAID_VIEWPORT_PADDING = 16;
const MERMAID_DRAG_CLICK_THRESHOLD = 4;
const MERMAID_SELECTED_FILTER = 'drop-shadow(0 0 4px rgb(236 72 153)) drop-shadow(0 0 1px rgb(236 72 153))';
// flowchart/state/class 的节点组、连线标签；sequence 的 actor / 消息 / note；子图框
const MERMAID_SELECTABLE = 'g.node, .edgeLabel, g.actor-man, text.actor, text.messageText, text.noteText, text.loopText, g.cluster';

// 从点击目标解析可选取的图元及其 label 文本
export function findMermaidSelectable(target: Element): { el: SVGElement; label: string } | null {
  const hit = target.closest(MERMAID_SELECTABLE);
  if (hit?.textContent?.trim()) {
    return { el: hit as SVGElement, label: hit.textContent.trim() };
  }
  // sequence actor 的 rect 与 text 是同组兄弟：点到 rect 时取组内 text
  const rect = target.closest('rect');
  const sibling = rect?.parentElement?.querySelector('text');
  if (rect && sibling?.textContent?.trim()) {
    return { el: rect.parentElement as unknown as SVGElement, label: sibling.textContent.trim() };
  }
  return null;
}

interface MermaidView {
  scale: number;
  x: number;
  y: number;
}

// Mermaid diagram renderer — wheel 缩放 / drag 平移 / 点选节点一句话改图
export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n();
  const tm = t.mermaid;
  // agent 跑动中禁发：run 未结束时 /api/agent/run 会 409（already has active run）
  const isProcessing = useAppStore((state) => state.isProcessing);
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [view, setView] = useState<MermaidView>({ scale: 1, x: MERMAID_VIEWPORT_PADDING, y: MERMAID_VIEWPORT_PADDING });
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [copied, setCopiedState] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const selectedElRef = useRef<SVGElement | null>(null);
  const svgSizeRef = useRef<{ width: number; height: number } | null>(null);
  // downTarget：setPointerCapture 会把后续事件 retarget 到 viewport，点选目标必须在 pointerdown 时记下
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; downTarget: Element | null } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const clearSelection = useCallback(() => {
    if (selectedElRef.current) {
      selectedElRef.current.style.filter = '';
      selectedElRef.current = null;
    }
    setSelectedLabel(null);
    setInstruction('');
  }, []);

  // 以 viewport 内某点为锚缩放（wheel 缩放围绕光标、按钮缩放围绕中心）
  const zoomAt = useCallback((px: number, py: number, nextScale: number) => {
    setView((v) => {
      const scale = Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, nextScale));
      const ratio = scale / v.scale;
      return { scale, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
    });
  }, []);

  // 计算适配窗口的初始视图（大图不再被 maxWidth:100% 压扁，直接按窗口宽度 fit）
  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    const size = svgSizeRef.current;
    if (!viewport || !size || size.width <= 0) return;
    const availableWidth = viewport.clientWidth - MERMAID_VIEWPORT_PADDING * 2;
    const scale = availableWidth > 0 ? Math.min(1, availableWidth / size.width) : 1;
    const height = Math.min(size.height * scale + MERMAID_VIEWPORT_PADDING * 2, MERMAID_VIEWPORT_MAX_HEIGHT);
    setViewportHeight(height);
    setView({
      scale,
      x: Math.max(MERMAID_VIEWPORT_PADDING, (viewport.clientWidth - size.width * scale) / 2),
      y: MERMAID_VIEWPORT_PADDING,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++mermaidIdCounter}`;
    // 按需动态加载 mermaid(~2.7MB 移出首屏),用到含 mermaid 的消息时才下载 chunk。
    loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg }) => {
        if (cancelled) return;
        // 成功必须无条件清 error：流式中部分代码失败会切到 CodeBlock 兜底（container 卸载），
        // 若把 setError(null) 绑在 container 存在性上，恢复路径会死锁在兜底分支
        setSvgMarkup(svg);
        setError(null);
      }).catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
        }
      });

    return () => { cancelled = true; };
  }, [code]);

  // svg 写入 DOM + 量尺寸 + fit（error 清空后 container 才挂载，所以与渲染解耦）
  useEffect(() => {
    if (!svgMarkup || !containerRef.current) return;
    selectedElRef.current = null;
    setSelectedLabel(null);
    containerRef.current.innerHTML = svgMarkup;
    const svgEl = containerRef.current.querySelector('svg');
    if (svgEl) {
      // 用自然尺寸渲染，缩放交给 transform；解掉 maxWidth:100% 压扁大图的问题
      const viewBox = svgEl.viewBox?.baseVal;
      const bounds = svgEl.getBoundingClientRect();
      const width = viewBox?.width || bounds.width;
      const height = viewBox?.height || bounds.height;
      svgSizeRef.current = { width, height };
      svgEl.style.maxWidth = 'none';
      svgEl.style.width = `${width}px`;
      svgEl.style.height = `${height}px`;
      svgEl.querySelectorAll<SVGElement>(MERMAID_SELECTABLE).forEach((el) => {
        el.style.cursor = 'pointer';
      });
    }
    fitToViewport();
  }, [svgMarkup, fitToViewport]);

  // wheel 缩放需要 preventDefault，React 合成事件是 passive 的，必须原生监听
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 普通滚轮留给聊天列表滚动
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // clamp：鼠标滚轮一格 deltaY≈±120，不 clamp 单格就放大 3 倍；触控板 pinch 的小 delta 不受影响
      const factor = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0025);
      setView((v) => {
        const scale = Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, v.scale * factor));
        const ratio = scale / v.scale;
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        return { scale, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
      });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [error]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
      downTarget: e.target instanceof Element ? e.target : null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [view.x, view.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < MERMAID_DRAG_CLICK_THRESHOLD && Math.abs(dy) < MERMAID_DRAG_CLICK_THRESHOLD) return;
    drag.moved = true;
    setView((v) => ({ ...v, x: drag.originX + dx, y: drag.originY + dy }));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;
    // 位移在阈值内视作点击：尝试选取节点
    const found = drag.downTarget ? findMermaidSelectable(drag.downTarget) : null;
    if (selectedElRef.current) selectedElRef.current.style.filter = '';
    if (found) {
      selectedElRef.current = found.el;
      found.el.style.filter = MERMAID_SELECTED_FILTER;
      setSelectedLabel(found.label);
      setTimeout(() => editInputRef.current?.focus(), 0);
    } else {
      selectedElRef.current = null;
      setSelectedLabel(null);
    }
  }, []);

  const handleSendEdit = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!selectedLabel || !trimmed || sending || useAppStore.getState().isProcessing) return;
    const codeBlock = '```mermaid\n' + code + '\n```\n';
    const promptValues = {
      label: selectedLabel,
      instruction: trimmed,
      codeBlock,
    };
    const prompt = tm.editPrompt.replace(
      /\{(label|instruction|codeBlock)\}/g,
      (_placeholder, key: keyof typeof promptValues) => promptValues[key],
    );
    setSending(true);
    try {
      await useMessageActionStore.getState().sendPrompt(prompt);
      clearSelection();
    } finally {
      setSending(false);
    }
  }, [instruction, selectedLabel, sending, code, tm.editPrompt, clearSelection]);

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
            onClick={() => {
              const viewport = viewportRef.current;
              zoomAt((viewport?.clientWidth ?? 0) / 2, (viewport?.clientHeight ?? 0) / 2, view.scale / 1.25);
            }}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title={tm.zoomOut}
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={fitToViewport}
            className="px-1.5 py-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 transition-colors text-xs"
            title={tm.zoomReset}
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            onClick={() => {
              const viewport = viewportRef.current;
              zoomAt((viewport?.clientWidth ?? 0) / 2, (viewport?.clientHeight ?? 0) / 2, view.scale * 1.25);
            }}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title={tm.zoomIn}
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
                <span className="text-green-400">{tm.copied}</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>{tm.copyCode}</span>
              </>
            )}
          </button>
        </div>
      </div>
      {/* Diagram viewport（wheel 缩放 / drag 平移 / 点选节点） */}
      <div
        ref={viewportRef}
        className="relative overflow-hidden select-none"
        style={{ height: viewportHeight ?? undefined, touchAction: 'none', cursor: 'grab' }}
        title={tm.zoomHint}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <div
          ref={containerRef}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: 'top left',
            width: 'max-content',
          }}
        />
      </div>
      {/* 标注即编辑：点选节点后底部滑出编辑栏 */}
      {selectedLabel && (
        <div className="border-t border-zinc-700 bg-zinc-800/80 px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-zinc-300 truncate">
              <span className="text-pink-300">✏ {tm.selectedLabel}</span>
              <span className="font-medium">「{selectedLabel}」</span>
            </span>
            <button
              onClick={clearSelection}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1.5"
            >
              ✕ {tm.cancel}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={editInputRef}
              type="text"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSendEdit();
                if (e.key === 'Escape') clearSelection();
              }}
              placeholder={tm.editPlaceholder}
              className="flex-1 min-w-0 rounded-lg bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-pink-400/60"
            />
            <button
              onClick={() => void handleSendEdit()}
              disabled={!instruction.trim() || sending || isProcessing}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-pink-500/20 text-pink-300 hover:bg-pink-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {tm.send}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

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
  color: 'rgb(113 113 122)',
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
    <SyntaxHighlighter
      className="scrollbar-hidden"
      style={oneDark}
      language={language || 'text'}
      showLineNumbers={showLineNumbers}
      startingLineNumber={chunk.startIndex + 1}
      customStyle={codeBlockStyle}
      lineNumberStyle={codeLineNumberStyle}
      wrapLongLines={wrapLines}
    >
      {chunk.code}
    </SyntaxHighlighter>
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
      className="my-3 rounded-xl bg-zinc-800-950 overflow-hidden border border-zinc-700 shadow-lg"
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
          <SyntaxHighlighter
            className="scrollbar-hidden"
            style={oneDark}
            language={language || 'text'}
            showLineNumbers={showLineNumbers}
            customStyle={codeBlockStyle}
            lineNumberStyle={codeLineNumberStyle}
            wrapLongLines={wrapLines}
          >
            {displayCode}
          </SyntaxHighlighter>
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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 border border-sky-500/20 hover:border-sky-500/40 transition-all cursor-pointer text-sm font-medium"
      title={title}
    >
      <Icon className="w-3 h-3 opacity-60" />
      {children}
    </button>
  );
};

// neo:// 是自定义 scheme，react-markdown 默认 urlTransform 白名单仅 http/https/mailto/xmpp，
// 会把 neo:// 剥成空 href 导致卡片不渲染；放行 neo://，其余仍走默认净化。
const neoUrlTransform = (url: string): string =>
  url.startsWith('neo://') ? url : defaultUrlTransform(url);

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
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={neoUrlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

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
  const asset = useMemo(
    () => buildMarkdownMediaAsset(src, alt, {
      ...mediaContext,
      messageId: mediaContext?.messageId || messageId,
    }),
    [src, alt, mediaContext?.sessionId, mediaContext?.turnId, mediaContext?.messageId, messageId],
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
    <span className="my-2 inline-block max-w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60 align-top">
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
      <span className="flex items-center justify-end border-t border-zinc-800 bg-zinc-950/70 px-2 py-1">
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
