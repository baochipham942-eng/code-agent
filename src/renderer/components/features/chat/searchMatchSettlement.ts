// 搜索/跳转命中的滚动 settlement（N-MEM-JOURNAL-SOURCEJUMP r3 从 TurnBasedTraceView
// 抽出）。一次 scrollToIndex 在「会话切换/设置页返回」的挂载测量窗口里会被首帧
// 锚定与测量沉降顶掉（真跑：目标轮短暂居中后一路沉降回底部），这里跨帧重发直到
// 滚动稳定且目标轮居中。
import type { RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { TraceTurn } from '@shared/contract/trace';
import type { SearchMatch } from './ChatSearchBar';

export interface SearchMatchSettlementArgs {
  activeMatch: SearchMatch;
  /** settlement 起始时的 turns 快照（作废判据的基准）。 */
  turns: TraceTurn[];
  /** 读当前 turns（挂载窗口里投影引用每帧都在换，作废判据用「长度 + 首尾 turnId」签名）。 */
  readTurns: () => TraceTurn[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerElementRef: RefObject<HTMLElement | null>;
  /** 跟随开关：在途按帧重压 false——瞬时触底会让 atBottomStateChange 重新武装吸底。 */
  followFlagRef: RefObject<boolean>;
  /** settlement 的取消槽（与其他程序滚动互斥）。 */
  cancelSlotRef: RefObject<(() => void) | null>;
  /** 由调用方传入的 turn DOM 定位器（避免与 TurnBasedTraceView 循环 import）。 */
  findTurnElement: (scroller: HTMLElement, turnId: string) => HTMLElement | null;
}

function turnsSignature(turns: TraceTurn[]): string {
  return `${turns.length}:${turns[0]?.turnId ?? ''}:${turns[turns.length - 1]?.turnId ?? ''}`;
}

/**
 * 启动命中滚动 settlement，最多 maxFrames 帧内反复重发 scrollToIndex(center)，
 * 滚动稳定且目标轮居中（或长于视口时整体铺满）才停；turns 首尾签名变化（翻页/
 * 新消息）时作废。返回取消函数。
 */
export function startSearchMatchSettlement(args: SearchMatchSettlementArgs): () => void {
  const { activeMatch, turns, readTurns, virtuosoRef, scrollerElementRef } = args;
  const signatureAtStart = turnsSignature(turns);
  let remainingFrames = 90;
  let lastScrollTop = -1;
  let frame: number | ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (frame !== null) {
      if (typeof requestAnimationFrame === 'function' && typeof frame === 'number') {
        cancelAnimationFrame(frame);
      } else {
        clearTimeout(frame);
      }
    }
    frame = null;
    if (args.cancelSlotRef.current === cancel) args.cancelSlotRef.current = null;
  };

  const targetCentered = () => {
    const turnId = turns[activeMatch.turnIndex]?.turnId;
    const scroller = scrollerElementRef.current;
    if (!turnId || !scroller) return false;
    const el = args.findTurnElement(scroller, turnId);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (rect.top <= view.top && rect.bottom >= view.bottom) return true;
    return Math.abs((rect.top + rect.bottom) / 2 - (view.top + view.bottom) / 2) <= view.height * 0.25;
  };

  const settle = () => {
    frame = null;
    if (turnsSignature(readTurns()) !== signatureAtStart) {
      cancel();
      return;
    }
    args.followFlagRef.current = false;
    const scroller = scrollerElementRef.current;
    const scrollStable = scroller !== null && Math.abs(scroller.scrollTop - lastScrollTop) < 1;
    if (scroller !== null) lastScrollTop = scroller.scrollTop;
    if (scrollStable && targetCentered()) {
      cancel();
      return;
    }
    // Search is exact navigation. Long virtualized jumps can be dropped or
    // left unfinished when animated across hundreds of unmounted items.
    virtuosoRef.current?.scrollToIndex({
      index: activeMatch.turnIndex,
      align: 'center',
      behavior: 'auto',
    });
    remainingFrames -= 1;
    if (remainingFrames <= 0) {
      cancel();
      return;
    }
    frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(settle)
      : setTimeout(settle, 16);
  };

  args.cancelSlotRef.current = cancel;
  settle();
  return cancel;
}
