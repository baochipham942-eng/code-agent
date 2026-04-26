// ============================================================================
// V2-B Tweak 5 类原子操作 - Tailwind className 互斥规则
// ----------------------------------------------------------------------------
// 给 UI 一个声明式 mutation API：「设 padding 为 8」「设 bg 为 red-600」，
// 这里负责把它翻译成 className 字符串的「移除哪些 + 添加哪个」。
//
// 范围：5 类（颜色 / 间距 / 字号 / 圆角 / 对齐）的 Tailwind 默认 palette。
// 自定义主题、arbitrary value、modifier (hover:/sm:) 不在 V2-B 范围。
//
// 互斥规则：
//   同 axis 下只能有一个值（写 p-8 时移除所有 p-{n}，但保留 px-{n}/py-{n}）
//   color target 互斥：写 bg-red-500 移除所有 bg-{color}-{shade}
// ============================================================================

// ----------------------------------------------------------------------------
// Mutation API
// ----------------------------------------------------------------------------

export type ColorTarget = 'text' | 'bg' | 'border';
export type SpacingAxis = 'p' | 'px' | 'py' | 'pt' | 'pr' | 'pb' | 'pl' | 'm' | 'mx' | 'my' | 'gap';
export type FontSizeKey = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';
export type RadiusKey = 'none' | 'sm' | '' /* default rounded */ | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full';
export type AlignAxis = 'text' | 'items' | 'justify';
export type TextAlignValue = 'left' | 'center' | 'right';
export type ItemsAlignValue = 'start' | 'center' | 'end';
export type JustifyAlignValue = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';

export type ClassMutation =
  | { kind: 'color'; target: ColorTarget; color: string; shade: number }
  | { kind: 'spacing'; axis: SpacingAxis; value: number }
  | { kind: 'fontSize'; size: FontSizeKey }
  | { kind: 'radius'; size: RadiusKey }
  | { kind: 'align'; axis: 'text'; value: TextAlignValue }
  | { kind: 'align'; axis: 'items'; value: ItemsAlignValue }
  | { kind: 'align'; axis: 'justify'; value: JustifyAlignValue };

export interface MutationResult {
  /** 应用后的有序去重 class 列表 */
  finalClasses: string[];
  /** 移除的 class（用于 audit log） */
  removed: string[];
  /** 添加的 class */
  added: string[];
  /** finalClasses 跟 input 是否真的不同（同值 noop 时 false） */
  changed: boolean;
}

// ----------------------------------------------------------------------------
// 5 类正则 / 互斥判定
// ----------------------------------------------------------------------------

// Tailwind color palette 关键词（只列默认 palette 的色族，自定义不识别）
const TW_COLORS =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)';
const TW_FONT_SIZES = '(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)';
const TW_RADIUS_SIZES = '(?:none|sm|md|lg|xl|2xl|3xl|full)';
const TW_TEXT_ALIGN = '(?:left|center|right|justify|start|end)';
const TW_ITEMS_ALIGN = '(?:start|end|center|baseline|stretch)';
const TW_JUSTIFY_ALIGN = '(?:start|end|center|between|around|evenly)';

// 「移除谁」的判定：传入一个 className，返回它属于哪个 axis（如 p-{n} → 'p'）
// 给定 mutation 时只移除同 axis 的 class
//
// 关键约束：必须先匹配更长的前缀（pt 在 p 之前），否则 p- 会把 pt-4 也吃掉
//
// 顺序保留：返回值 axisKey 用于"两个 className 是否同 axis"的判定
type AxisMatcher = { axis: string; pattern: RegExp };

const SPACING_MATCHERS: AxisMatcher[] = [
  // 双字符前缀必须排在单字符前
  { axis: 'gap', pattern: /^gap-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'px', pattern: /^px-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'py', pattern: /^py-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'pt', pattern: /^pt-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'pr', pattern: /^pr-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'pb', pattern: /^pb-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'pl', pattern: /^pl-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'mx', pattern: /^mx-(\d+(?:\.\d+)?|px|auto)$/ },
  { axis: 'my', pattern: /^my-(\d+(?:\.\d+)?|px|auto)$/ },
  { axis: 'p', pattern: /^p-(\d+(?:\.\d+)?|px)$/ },
  { axis: 'm', pattern: /^m-(-?\d+(?:\.\d+)?|px|auto)$/ },
];

const COLOR_MATCHERS: AxisMatcher[] = [
  { axis: 'text-color', pattern: new RegExp(`^text-${TW_COLORS}-\\d{2,3}$`) },
  { axis: 'bg-color', pattern: new RegExp(`^bg-${TW_COLORS}(?:-\\d{2,3})?$`) }, // bg-white 也认
  { axis: 'border-color', pattern: new RegExp(`^border-${TW_COLORS}-\\d{2,3}$`) },
];

const FONT_SIZE_MATCHER: AxisMatcher = { axis: 'text-size', pattern: new RegExp(`^text-${TW_FONT_SIZES}$`) };

const RADIUS_MATCHER: AxisMatcher = { axis: 'rounded', pattern: new RegExp(`^rounded(?:-${TW_RADIUS_SIZES})?$`) };

const ALIGN_MATCHERS: AxisMatcher[] = [
  { axis: 'text-align', pattern: new RegExp(`^text-${TW_TEXT_ALIGN}$`) },
  { axis: 'items', pattern: new RegExp(`^items-${TW_ITEMS_ALIGN}$`) },
  { axis: 'justify', pattern: new RegExp(`^justify-${TW_JUSTIFY_ALIGN}$`) },
];

const ALL_MATCHERS = [
  ...SPACING_MATCHERS,
  ...COLOR_MATCHERS,
  FONT_SIZE_MATCHER,
  RADIUS_MATCHER,
  ...ALIGN_MATCHERS,
];

/** 判定一个 className 属于哪个 axis；不属于任何已知 axis 返回 null */
export function classifyClassName(cls: string): string | null {
  for (const m of ALL_MATCHERS) {
    if (m.pattern.test(cls)) return m.axis;
  }
  return null;
}

// ----------------------------------------------------------------------------
// mutation → final classes
// ----------------------------------------------------------------------------

function buildClassFromMutation(m: ClassMutation): { axis: string; cls: string } {
  switch (m.kind) {
    case 'color': {
      // bg-white / bg-black 没有 shade
      const isShadeless = (m.color === 'white' || m.color === 'black') && m.target === 'bg';
      const cls = isShadeless ? `${m.target}-${m.color}` : `${m.target}-${m.color}-${m.shade}`;
      return { axis: `${m.target}-color`, cls };
    }
    case 'spacing':
      return { axis: m.axis, cls: `${m.axis}-${m.value}` };
    case 'fontSize':
      return { axis: 'text-size', cls: `text-${m.size}` };
    case 'radius':
      return { axis: 'rounded', cls: m.size ? `rounded-${m.size}` : 'rounded' };
    case 'align': {
      // axis 是 'text' | 'items' | 'justify'，但 text 类的 axis key 用 'text-align' 避免跟 text-color/text-size 冲突
      const axisKey = m.axis === 'text' ? 'text-align' : m.axis;
      return { axis: axisKey, cls: `${m.axis}-${m.value}` };
    }
  }
}

/**
 * 把 mutation 应用到 className 列表上：
 *   1. 算出 mutation 对应的 (axis, newCls)
 *   2. 移除所有当前列表里 classify === axis 的 class
 *   3. append newCls（如果列表里已经有同 axis class，移除后用同位置 splice 维持顺序）
 *   4. 返回 finalClasses + removed + added + changed
 */
export function applyMutation(currentClasses: string[], mutation: ClassMutation): MutationResult {
  const { axis, cls: newCls } = buildClassFromMutation(mutation);
  const removed: string[] = [];
  let firstMatchIdx = -1;
  const kept: string[] = [];

  currentClasses.forEach((c, i) => {
    if (classifyClassName(c) === axis) {
      removed.push(c);
      if (firstMatchIdx < 0) firstMatchIdx = i;
    } else {
      kept.push(c);
    }
  });

  // 如果 newCls 已经在 kept 里（其他位置漏判），就 noop
  const alreadyHasNew = kept.includes(newCls);
  if (alreadyHasNew && removed.length === 0) {
    return { finalClasses: currentClasses, removed: [], added: [], changed: false };
  }

  let finalClasses: string[];
  if (firstMatchIdx >= 0 && !alreadyHasNew) {
    // 同 axis 移除后在原首位置插入新值，维持视觉顺序
    finalClasses = [...kept.slice(0, firstMatchIdx), newCls, ...kept.slice(firstMatchIdx)];
  } else if (!alreadyHasNew) {
    finalClasses = [...kept, newCls];
  } else {
    finalClasses = kept;
  }

  const added = alreadyHasNew ? [] : [newCls];
  const changed = removed.length > 0 || added.length > 0;
  // 同值无改动时
  if (removed.length === 1 && removed[0] === newCls && added.length === 1) {
    return { finalClasses: currentClasses, removed: [], added: [], changed: false };
  }
  return { finalClasses, removed, added, changed };
}
