// 工具条溢出折叠共享 hook（2026-08-01 K1 工单）：窄栏下元素只会 flex-wrap 换行把条撑高，
// 改为「放得下平铺、放不下收进 ⋯」——ResizeObserver 观察满宽外条，逐项实测宽度累加决定切点，
// 不写死断点（拖窗口/拖分隔条/进出专注模式都实时重算）；宽度回来能再铺回去（双向）。
// 滞回：放回去要比收进来多留 hysteresis px 余量，容器宽度在切点附近微抖时不来回切。
// jsdom/SSR 下量不到宽度（clientWidth=0）→ 一律全可见不收折，测试与静态渲染行为不变。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ToolbarOverflowOptions<T extends string> {
  /** 决定可用宽度的容器（一般是满宽外条，left-2 right-2 那个）。 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 参与收折的项（按显示顺序）；放不下时从末尾开始收。常驻锚点项（⋯ 按钮）不进此列表。 */
  itemIds: readonly T[];
  /** 有项被收折时为收折入口（⋯ 按钮/当前色圆点）预留的宽度 px 兜底；给了 reserveRef 以实测为准。 */
  reserveWidth: number;
  /** 收折入口元素 ref（如图象动词条的「更多」锚点），实测其宽度替代 reserveWidth 兜底值。 */
  reserveRef?: React.RefObject<HTMLElement | null>;
  /** 相邻元素间距 px（对应条上 gap-*）。默认 4（gap-1）。 */
  gap?: number;
  /** 内条横向不可压缩部分（左右 padding + border）px。默认 0。 */
  chromeWidth?: number;
  /** 滞回余量 px：放回去要求比刚好放下多留这么多。默认 8。 */
  hysteresis?: number;
}

export interface ToolbarOverflowResult<T extends string> {
  /** 当前应收折的项（进溢出菜单）。量不到宽度时为空集（全平铺）。 */
  overflowed: ReadonlySet<T>;
  /** 给每个可收折项的外层容器挂这个 ref，hook 量它的 offsetWidth 并缓存。 */
  itemRef: (id: T) => (el: HTMLElement | null) => void;
}

/**
 * 纯决策函数（导出供单测）：给定各项实测宽度与可用宽度，返回能平铺的前缀项数。
 * 收折方向：从末尾收起；有任何收折时总额外计入 reserve 宽度。
 * 滞回：fit 比 prev 大（要往回放）时要求 total(fit) ≤ avail - hysteresis，否则维持 prev。
 */
export function computeVisibleCount(
  widths: readonly number[],
  avail: number,
  reserve: number,
  gap: number,
  chrome: number,
  hysteresis: number,
  prev: number,
): number {
  if (avail <= 0) return prev;
  const total = (k: number): number => {
    const collapsed = k < widths.length;
    const elements = k + (collapsed ? 1 : 0);
    let sum = chrome + widths.slice(0, k).reduce((a, b) => a + b, 0);
    if (collapsed) sum += reserve;
    if (elements > 1) sum += gap * (elements - 1);
    return sum;
  };
  let fit = widths.length;
  while (fit > 0 && total(fit) > avail) fit--;
  if (fit > prev && total(fit) > avail - hysteresis) return prev;
  return fit;
}

export function useToolbarOverflow<T extends string>(
  options: ToolbarOverflowOptions<T>,
): ToolbarOverflowResult<T> {
  const {
    containerRef,
    itemIds,
    reserveWidth,
    reserveRef,
    gap = 4,
    chromeWidth = 0,
    hysteresis = 8,
  } = options;

  const [overflowed, setOverflowed] = useState<ReadonlySet<T>>(() => new Set());
  const elsRef = useRef(new Map<T, HTMLElement>());
  const widthsRef = useRef(new Map<T, number>());
  const prevCountRef = useRef(itemIds.length);
  // itemIds 标识用引用相等即可（调用方 useMemo/常量），展开成 key 供 effect 依赖比较。
  const idsKey = itemIds.join('');

  const recompute = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    const avail = container.clientWidth;
    // 量不到宽度（jsdom/SSR/隐藏）→ 不收折。
    if (avail <= 0) return;
    // 先刷新仍在 DOM 里的项的实测宽度（收折走的项用上次的缓存值）。
    for (const [id, el] of elsRef.current) {
      const w = el.offsetWidth;
      if (w > 0) widthsRef.current.set(id, w);
    }
    const widths = itemIds.map((id) => widthsRef.current.get(id) ?? 0);
    // 有项从没量到过（首帧前）→ 先全铺量一轮再说。
    if (widths.some((w) => w <= 0)) return;
    const reserveEl = reserveRef?.current;
    const reserve = reserveEl && reserveEl.offsetWidth > 0 ? reserveEl.offsetWidth : reserveWidth;
    const next = computeVisibleCount(widths, avail, reserve, gap, chromeWidth, hysteresis, prevCountRef.current);
    prevCountRef.current = next;
    const nextSet = new Set(itemIds.slice(next));
    setOverflowed((cur) => {
      if (cur.size === nextSet.size && [...nextSet].every((id) => cur.has(id))) return cur;
      return nextSet;
    });
  }, [containerRef, itemIds, reserveRef, reserveWidth, gap, chromeWidth, hysteresis]);

  const itemRef = useCallback(
    (id: T) =>
      (el: HTMLElement | null): void => {
        if (el) elsRef.current.set(id, el);
        else elsRef.current.delete(id);
      },
    [],
  );

  // 每次渲染后量一轮（项渲染/文案变化会影响宽度）；setOverflowed 只在结果变化时置新值，不会死循环。
  useLayoutEffect(() => {
    recompute();
  });

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    return () => ro.disconnect();
    // idsKey 变化代表参与项集合变了（如 exportPptx 槽后出现），重挂观察并重算。
  }, [containerRef, recompute, idsKey]);

  return { overflowed, itemRef };
}
