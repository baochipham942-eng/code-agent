// ============================================================================
// MermaidDiagram — mermaid 图渲染 + 缩放/平移 + 点选标注 + 高度缓存
// 从 messageContentParts.tsx 纯结构性拆出（大文件门），零行为改动
// ============================================================================

import React, { useState, useCallback, memo, useRef, useEffect } from 'react';
import { Code2, Copy, Check, ZoomIn, ZoomOut } from 'lucide-react';
import { loadMermaid } from './mermaidLoader';
import { UI } from '@shared/constants';
import { useAppStore } from '../../../../stores/appStore';
import { useMessageActionStore } from '../../../../stores/messageActionStore';
import { useI18n } from '../../../../hooks/useI18n';
// 与 messageContentParts 互引（错误兜底渲染 CodeBlock）：双方都只在渲染期解引用，模块求值期无环
import { CodeBlock } from './messageContentParts';

// Unique ID counter for mermaid diagrams
let mermaidIdCounter = 0;

const MERMAID_MIN_SCALE = 0.1;
const MERMAID_MAX_SCALE = 4;
const MERMAID_VIEWPORT_MAX_HEIGHT = 560;
const MERMAID_VIEWPORT_PADDING = 16;
// 异步渲染完成前 viewport 的占位高：没有它高度先塌 0 再撑开，整页跟着跳
const MERMAID_PLACEHOLDER_HEIGHT = 240;
const MERMAID_HEIGHT_CACHE_MAX = 200;

// 量过的 fit 高度按图源码缓存：重进历史会话时同一张图第一帧就按精确高度占位，零跳动
const mermaidHeightCache = new Map<string, number>();

export function rememberMermaidHeight(code: string, height: number): void {
  if (!mermaidHeightCache.has(code) && mermaidHeightCache.size >= MERMAID_HEIGHT_CACHE_MAX) {
    const oldest = mermaidHeightCache.keys().next().value;
    if (oldest !== undefined) mermaidHeightCache.delete(oldest);
  }
  mermaidHeightCache.set(code, height);
}

export function getCachedMermaidHeight(code: string): number | null {
  return mermaidHeightCache.get(code) ?? null;
}
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

export interface MermaidView {
  scale: number;
  x: number;
  y: number;
}

export function clampMermaidScale(scale: number): number {
  return Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, scale));
}

// 以 viewport 内 (px,py) 为锚把 view 缩放到 nextScale：缩放前后锚点处的图内容保持不动
export function zoomMermaidViewAt(view: MermaidView, px: number, py: number, nextScale: number): MermaidView {
  const scale = clampMermaidScale(nextScale);
  const ratio = scale / view.scale;
  return { scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

// wheel 缩放因子：鼠标滚轮一格 deltaY≈±120，不 clamp 单格就放大 3 倍；触控板 pinch 的小 delta 不受影响
export function mermaidWheelZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-100, Math.min(100, deltaY)) * 0.0025);
}

// Mermaid diagram renderer — wheel 缩放 / drag 平移 / 点选节点一句话改图
export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n();
  const tm = t.mermaid;
  // agent 跑动中禁发：run 未结束时 /api/agent/run 会 409（already has active run）
  const isProcessing = useAppStore((state) => state.isProcessing);
  // 无会话上下文（ChatView 未注册发送通道）时隐藏标注入口：节点不显示可点手势、
  // 点击也不弹编辑栏——不给用户假的可编辑假象（同 DocumentBlock 无源文件约定）
  const canAnnotate = useMessageActionStore((state) => state._send !== null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [view, setView] = useState<MermaidView>({ scale: 1, x: MERMAID_VIEWPORT_PADDING, y: MERMAID_VIEWPORT_PADDING });
  const [viewportHeight, setViewportHeight] = useState<number | null>(() => getCachedMermaidHeight(code));
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
    setView((v) => zoomMermaidViewAt(v, px, py, nextScale));
  }, []);

  // 计算适配窗口的初始视图（大图不再被 maxWidth:100% 压扁，直接按窗口宽度 fit）
  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    const size = svgSizeRef.current;
    if (!viewport || !size || size.width <= 0) return;
    const availableWidth = viewport.clientWidth - MERMAID_VIEWPORT_PADDING * 2;
    const scale = availableWidth > 0 ? Math.min(1, availableWidth / size.width) : 1;
    const height = Math.min(size.height * scale + MERMAID_VIEWPORT_PADDING * 2, MERMAID_VIEWPORT_MAX_HEIGHT);
    rememberMermaidHeight(code, height);
    setViewportHeight(height);
    setView({
      scale,
      x: Math.max(MERMAID_VIEWPORT_PADDING, (viewport.clientWidth - size.width * scale) / 2),
      y: MERMAID_VIEWPORT_PADDING,
    });
  }, [code]);

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
        el.style.cursor = canAnnotate ? 'pointer' : '';
      });
    }
    fitToViewport();
  }, [svgMarkup, fitToViewport, canAnnotate]);

  // wheel 缩放需要 preventDefault，React 合成事件是 passive 的，必须原生监听
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 普通滚轮留给聊天列表滚动
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = mermaidWheelZoomFactor(e.deltaY);
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => zoomMermaidViewAt(v, px, py, v.scale * factor));
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

  const handlePointerUp = useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;
    // 无会话上下文时标注入口隐藏：点击只平移/缩放，不进入点选
    if (!canAnnotate) return;
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
  }, [canAnnotate]);

  const handleSendEdit = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!canAnnotate || !selectedLabel || !trimmed || sending || useAppStore.getState().isProcessing) return;
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
  }, [canAnnotate, instruction, selectedLabel, sending, code, tm.editPrompt, clearSelection]);

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
          <Code2 className="w-3.5 h-3.5 text-badge-accent" />
          <span className="text-xs font-medium text-badge-accent">Mermaid</span>
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
                <Check className="w-3.5 h-3.5 text-badge-success" />
                <span className="text-badge-success">{tm.copied}</span>
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
        style={{ height: viewportHeight ?? MERMAID_PLACEHOLDER_HEIGHT, touchAction: 'none', cursor: 'grab' }}
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
              <span className="text-badge-accent">✏ {tm.selectedLabel}</span>
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
              className="flex-1 min-w-0 rounded-lg bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-badge-accent/60"
            />
            <button
              onClick={() => void handleSendEdit()}
              disabled={!canAnnotate || !instruction.trim() || sending || isProcessing}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-pink-500/20 text-badge-accent hover:bg-pink-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {tm.send}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
