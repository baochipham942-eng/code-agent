// ============================================================================
// 轮次导航（N-TURNRAIL）：贴聊天列右缘的一条刻度条，每轮一格、当前轮高亮、悬停出
// 预览气泡；点条头展开成「第 N 轮 · 用户那句」的清单；聊天列窄于 640px 时只留一个
// 「第 N 轮」小按钮。宽窄两态用 CSS 容器查询切换（父容器带 @container），不加
// ResizeObserver——TurnBasedTraceView 有「观察器只许盯活动轮」的既定契约。
// 历史整段加载，所有轮都在内存里，跳转由父组件用 scrollToIndex 完成（没有「未加载」态）。
// 不碰「回到底部」（留在输入框上方居中）、不联动右栏「日志」。
// ============================================================================
import React, { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { TURN_RAIL_MIN_TURNS, type TurnRailItem } from '../../../utils/turnRailItems';

interface TurnRailProps {
  items: TurnRailItem[];
  activeTurnId: string | null;
  onJump: (turnId: string) => void;
}

/** 相邻两格的固定间距：条的长度跟轮数走，超出高度时条内滚动 */
const TICK_PITCH_PX = 10;
/** 聊天列窄于这个宽度时收成小按钮（容器查询断点，与 TurnBasedTraceView 的 @container 配对） */
const TURN_RAIL_NARROW_BELOW_PX = 640;
const WIDE_ONLY = `@max-[${TURN_RAIL_NARROW_BELOW_PX}px]:hidden`;
const NARROW_ONLY = `@min-[${TURN_RAIL_NARROW_BELOW_PX}px]:hidden`;

function fill(template: string, values: Record<string, number | string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);
}

export const TurnRail: React.FC<TurnRailProps> = ({ items, activeTurnId, onJump }) => {
  const { t } = useI18n();
  const text = t.turnRail;
  const [expanded, setExpanded] = useState(false);
  const [previewTurnId, setPreviewTurnId] = useState<string | null>(null);
  const previewId = useId();
  const activeTickRef = useRef<HTMLButtonElement | null>(null);
  const pointerInsideRef = useRef(false);

  // 当前轮跟着滚动走时把它的刻度保持在条的可视区里；鼠标在条上时不动，别从手底下溜走。
  useEffect(() => {
    if (pointerInsideRef.current) return;
    activeTickRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeTurnId]);

  if (items.length < TURN_RAIL_MIN_TURNS) return null;

  const active = items.find((item) => item.turnId === activeTurnId) ?? null;
  const preview = items.find((item) => item.turnId === previewTurnId) ?? null;
  const turnLabel = (item: TurnRailItem) => fill(text.turnN, { n: item.turnNumber });

  return (
    <div data-testid="turn-rail" className="contents">
      <nav
        data-testid="turn-rail-ticks"
        aria-label={text.label}
        className={`absolute right-1 top-3 bottom-16 z-10 flex w-7 flex-col items-end ${WIDE_ONLY}`}
        onPointerEnter={() => { pointerInsideRef.current = true; }}
        onPointerLeave={() => { pointerInsideRef.current = false; }}
      >
        <button /* ds-allow:button: 条头的图标级展开开关，Button primitive 无此紧凑变体 */
          type="button"
          aria-label={text.expand}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mb-1 h-5 w-5 rounded text-[11px] leading-none text-zinc-500 transition-colors hover:text-zinc-200"
        >
          ≡
        </button>
        <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-visible [scrollbar-width:none]">
          {items.map((item) => {
            const isActive = item.turnId === activeTurnId;
            const showingPreview = item.turnId === previewTurnId;
            return (
              <button /* ds-allow:button: 每轮一格的 10px 定距刻度，Button primitive 的最小尺寸装不下 */
                key={item.turnId}
                ref={isActive ? activeTickRef : undefined}
                type="button"
                aria-label={fill(text.jumpTo, { n: item.turnNumber })}
                aria-current={isActive ? 'true' : undefined}
                aria-describedby={showingPreview ? previewId : undefined}
                onClick={() => onJump(item.turnId)}
                onMouseEnter={() => setPreviewTurnId(item.turnId)}
                onMouseLeave={() => setPreviewTurnId(null)}
                onFocus={() => setPreviewTurnId(item.turnId)}
                onBlur={() => setPreviewTurnId(null)}
                style={{ height: TICK_PITCH_PX }}
                className="group flex w-5 items-center justify-end"
              >
                <span
                  className={`block h-0.5 rounded transition-all ${
                    isActive ? 'w-3.5 bg-primary-500' : showingPreview ? 'w-3 bg-zinc-300' : 'w-2 bg-zinc-600 group-hover:bg-zinc-400'
                  }`}
                />
              </button>
            );
          })}
        </div>
        {preview && (
          <div
            id={previewId}
            role="tooltip"
            className="pointer-events-none absolute right-8 top-1/2 w-64 -translate-y-1/2 rounded-lg border border-zinc-700/60 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm"
          >
            <div className="mb-0.5 text-[11px] tabular-nums text-badge-accent">{turnLabel(preview)}</div>
            <div className="text-zinc-100">{preview.prompt || turnLabel(preview)}</div>
            {preview.response && <div className="mt-1 text-zinc-400">{preview.response}</div>}
          </div>
        )}
      </nav>
      <div data-testid="turn-rail-narrow" className={`absolute right-3 bottom-16 z-10 ${NARROW_ONLY}`}>
        <button /* ds-allow:button: 窄屏下的迷你位置徽标，Button primitive 无此紧凑变体 */
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="rounded-full border border-zinc-600/50 bg-zinc-800/80 px-2 py-1 text-[11px] tabular-nums text-zinc-200 shadow-lg backdrop-blur-sm"
        >
          {fill(text.turnN, { n: active?.turnNumber ?? items[items.length - 1].turnNumber })}
        </button>
      </div>
      {expanded && (
        <div
          data-testid="turn-rail-list"
          className="absolute right-1 top-3 bottom-16 z-10 flex w-64 max-w-[60%] flex-col rounded-lg border border-zinc-700/60 bg-zinc-900/95 shadow-lg backdrop-blur-sm"
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs text-zinc-300">
            <span>{fill(text.allTurns, { count: items.length })}</span>
            <button /* ds-allow:button: 清单头部的紧凑文字收起动作，Button primitive 会撑高标题行 */
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded px-1.5 py-0.5 text-zinc-400 transition-colors hover:text-zinc-100"
            >
              {text.collapse}
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {items.map((item) => {
              const isActive = item.turnId === activeTurnId;
              return (
                <li key={item.turnId} aria-current={isActive ? 'true' : undefined}>
                  <button /* ds-allow:button: 清单整行可点，Button primitive 无此列表行形态 */
                    type="button"
                    onClick={() => onJump(item.turnId)}
                    className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-xs transition-colors hover:bg-zinc-800/80 ${isActive ? 'bg-primary-500/10 text-zinc-100' : 'text-zinc-300'}`}
                  >
                    <span className="shrink-0 tabular-nums text-zinc-500">{turnLabel(item)}</span>
                    <span className="truncate">{item.prompt}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};
