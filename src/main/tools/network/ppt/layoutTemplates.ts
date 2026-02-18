// ============================================================================
// Layout Templates - 布局坐标/字号/间距配置
// ============================================================================
// 将所有硬编码坐标提取到配置对象，不同主题/风格只需切换配置。
// ============================================================================

import { DEFAULT_CARD_RADIUS } from './constants';

// ============================================================================
// Template Interface
// ============================================================================

export interface StatsTemplate {
  cardWidth: number;
  cardHeight: number;
  gap: number;
  startY: number;
  numberFontSize: number;
  descFontSize: number;
  numberYOffset: number;     // 大数字 Y 偏移
  numberHeight: number;      // 大数字区高度
  dividerYOffset: number;    // 分隔线 Y 偏移
  descYOffset: number;       // 描述文字 Y 偏移
  cardRadius: number;
}

export interface Cards2Template {
  leftX: number;
  leftW: number;
  rightX: number;    // 右侧卡片列表起始 X（相对 leftX + leftW 计算）
  rightW: number;
  cardY: number;
  cardH: number;
  padding: number;
  titleFontSize: number;
  bodyFontSize: number;
  maxRowH: number;          // 左侧单行最大高度
  rightGap: number;         // 右侧卡片间距
  rightMaxCardH: number;    // 右侧单卡最大高度
  cardRadius: number;
}

export interface Cards3Template {
  cardWidth: number;
  gap: number;
  startX: number;
  baseY: number;
  baseH: number;
  centerYOffset: number;    // 中间卡片 Y 偏移
  centerHBonus: number;     // 中间卡片高度增加
  numberFontSize: number;
  bodyFontSize: number;
  cardRadius: number;
}

export interface TimelineTemplate {
  startX: number;
  baseY: number;
  stepWidth: number;
  lineYOffset: number;      // 连接线相对 baseY 偏移
  lineWidth: number;        // 连接线总宽
  lineHeight: number;       // 连接线粗细
  progressWidth: number;    // 进度色宽度
  dotSize: number;          // 圆点直径
  dotYOffset: number;       // 圆点 Y 偏移
  labelYOffset: number;     // STEP 标签 Y 偏移
  labelFontSize: number;
  contentYOffset: number;   // 内容文字 Y 偏移
  contentHeight: number;    // 内容文字高度
  contentFontSize: number;
  cardRadius: number;
}

export interface ComparisonTemplate {
  leftX: number;
  leftW: number;
  rightX: number;
  rightW: number;
  cardY: number;
  cardH: number;
  contentStartY: number;    // 内容起始 Y
  maxRowH: number;
  fontSize: number;
  cardRadius: number;
}

export interface TwoColumnTemplate {
  dividerX: number;
  dividerW: number;         // 分隔线宽度
  contentStartY: number;
  leftDotX: number;
  leftTextX: number;
  leftTextW: number;
  rightDotX: number;
  rightTextX: number;
  rightTextW: number;
  dotSize: number;
  maxRowH: number;
  fontSize: number;
}

export interface PageNumberTemplate {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  badgeRadius: number;
}

export interface ImageTemplate {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 完整的布局模板配置 */
export interface LayoutTemplate {
  stats: StatsTemplate;
  cards2: Cards2Template;
  cards3: Cards3Template;
  timeline: TimelineTemplate;
  comparison: ComparisonTemplate;
  twoColumn: TwoColumnTemplate;
  pageNumber: PageNumberTemplate;
  image: ImageTemplate;
}

// ============================================================================
// Template Presets
// ============================================================================

/** 默认模板（当前硬编码值，非 Apple 主题） */
const DEFAULT_TEMPLATE: LayoutTemplate = {
  stats: {
    cardWidth: 2.05,
    cardHeight: 3.2,
    gap: 0.25,
    startY: 1.55,
    numberFontSize: 36,
    descFontSize: 11,
    numberYOffset: 0.8,
    numberHeight: 0.8,
    dividerYOffset: 1.7,
    descYOffset: 1.85,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  cards2: {
    leftX: 0.35,
    leftW: 4.5,
    rightX: 5.05,
    rightW: 4.5,
    cardY: 1.5,
    cardH: 3.7,
    padding: 0.3,
    titleFontSize: 13,
    bodyFontSize: 12,
    maxRowH: 0.9,
    rightGap: 0.2,
    rightMaxCardH: 1.15,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  cards3: {
    cardWidth: 2.85,
    gap: 0.3,
    startX: 0.6,
    baseY: 1.65,
    baseH: 3.5,
    centerYOffset: -0.1,
    centerHBonus: 0.2,
    numberFontSize: 28,
    bodyFontSize: 12,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  timeline: {
    startX: 0.65,
    baseY: 2.6,
    stepWidth: 2.2,
    lineYOffset: 0,
    lineWidth: 7.8,
    lineHeight: 0.03,
    progressWidth: 7.8,
    dotSize: 0.22,
    dotYOffset: 0,
    labelYOffset: -0.65,
    labelFontSize: 13,
    contentYOffset: 0.2,
    contentHeight: 1.6,
    contentFontSize: 11,
    cardRadius: 0.18,
  },
  comparison: {
    leftX: 0.35,
    leftW: 4.4,
    rightX: 5.2,
    rightW: 4.4,
    cardY: 1.5,
    cardH: 3.7,
    contentStartY: 1.8,
    maxRowH: 0.85,
    fontSize: 12,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  twoColumn: {
    dividerX: 4.95,
    dividerW: 0.01,
    contentStartY: 1.55,
    leftDotX: 0.65,
    leftTextX: 0.9,
    leftTextW: 3.85,
    rightDotX: 5.25,
    rightTextX: 5.5,
    rightTextW: 3.85,
    dotSize: 0.1,
    maxRowH: 0.75,
    fontSize: 13,
  },
  pageNumber: {
    x: 9.1,
    y: 0.35,
    w: 0.55,
    h: 0.55,
    fontSize: 12,
    badgeRadius: 0.08,
  },
  image: {
    x: 5.0,
    y: 1.3,
    w: 4.6,
    h: 3.8,
  },
};

/** Apple Keynote 风格模板 */
const APPLE_TEMPLATE: LayoutTemplate = {
  stats: {
    cardWidth: 2.05,
    cardHeight: 2.8,
    gap: 0.25,
    startY: 1.55,
    numberFontSize: 36,
    descFontSize: 11,
    numberYOffset: 0.4,
    numberHeight: 1.0,
    dividerYOffset: 1.5,
    descYOffset: 1.65,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  cards2: {
    leftX: 0.35,
    leftW: 4.5,
    rightX: 5.05,
    rightW: 4.5,
    cardY: 1.5,
    cardH: 3.7,
    padding: 0.3,
    titleFontSize: 14,
    bodyFontSize: 13,
    maxRowH: 0.9,
    rightGap: 0.2,
    rightMaxCardH: 1.15,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  cards3: {
    cardWidth: 2.85,
    gap: 0.3,
    startX: 0.6,
    baseY: 1.65,
    baseH: 3.5,
    centerYOffset: -0.1,
    centerHBonus: 0.2,
    numberFontSize: 32,
    bodyFontSize: 13,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  timeline: {
    startX: 0.65,
    baseY: 2.6,
    stepWidth: 2.2,
    lineYOffset: 0,
    lineWidth: 7.8,
    lineHeight: 0.025,
    progressWidth: 7.8,
    dotSize: 0.22,
    dotYOffset: 0,
    labelYOffset: -0.65,
    labelFontSize: 14,
    contentYOffset: 0.2,
    contentHeight: 1.6,
    contentFontSize: 12,
    cardRadius: 0.18,
  },
  comparison: {
    leftX: 0.35,
    leftW: 4.4,
    rightX: 5.2,
    rightW: 4.4,
    cardY: 1.5,
    cardH: 3.7,
    contentStartY: 1.8,
    maxRowH: 0.85,
    fontSize: 13,
    cardRadius: DEFAULT_CARD_RADIUS,
  },
  twoColumn: {
    dividerX: 4.95,
    dividerW: 0.02,       // Apple 用稍粗一点的分隔线但带透明
    contentStartY: 1.55,
    leftDotX: 0.65,
    leftTextX: 0.9,
    leftTextW: 3.85,
    rightDotX: 5.25,
    rightTextX: 5.5,
    rightTextW: 3.85,
    dotSize: 0.1,
    maxRowH: 0.75,
    fontSize: 14,
  },
  pageNumber: {
    x: 9.2,
    y: 0.4,
    w: 0.5,
    h: 0.4,
    fontSize: 11,
    badgeRadius: 0,
  },
  image: {
    x: 5.0,
    y: 1.3,
    w: 4.6,
    h: 3.8,
  },
};

/** 企业正式风格 */
const CORPORATE_TEMPLATE: LayoutTemplate = {
  ...DEFAULT_TEMPLATE,
  stats: {
    ...DEFAULT_TEMPLATE.stats,
    cardWidth: 2.1,
    cardHeight: 3.0,
    numberFontSize: 32,
    descFontSize: 11,
    cardRadius: 0.12,
  },
  cards3: {
    ...DEFAULT_TEMPLATE.cards3,
    cardWidth: 2.8,
    gap: 0.35,
    startX: 0.65,
    numberFontSize: 24,
    cardRadius: 0.12,
  },
};

/** 现代极简风格 */
const MODERN_MINIMAL_TEMPLATE: LayoutTemplate = {
  ...DEFAULT_TEMPLATE,
  stats: {
    ...DEFAULT_TEMPLATE.stats,
    cardWidth: 2.15,
    cardHeight: 2.9,
    numberFontSize: 40,
    descFontSize: 10,
    cardRadius: 0.15,
  },
  timeline: {
    ...DEFAULT_TEMPLATE.timeline,
    dotSize: 0.20,
    cardRadius: 0.12,
  },
};

// ============================================================================
// Template Preset Registry
// ============================================================================

export const TEMPLATE_PRESETS: Record<string, LayoutTemplate> = {
  'default': DEFAULT_TEMPLATE,
  'apple-keynote': APPLE_TEMPLATE,
  'corporate-formal': CORPORATE_TEMPLATE,
  'modern-minimal': MODERN_MINIMAL_TEMPLATE,
};

// 主题名称 → 模板预设映射
const THEME_TO_PRESET: Record<string, string> = {
  'apple-dark': 'apple-keynote',
  'corporate': 'corporate-formal',
  'minimal-mono': 'modern-minimal',
  // 其他主题使用 default
};

/**
 * 根据主题名称获取对应的布局模板
 */
export function getTemplateForTheme(themeName: string): LayoutTemplate {
  const presetName = THEME_TO_PRESET[themeName] || 'default';
  return TEMPLATE_PRESETS[presetName] || TEMPLATE_PRESETS['default'];
}
