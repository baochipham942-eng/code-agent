// ============================================================================
// Master Decorations - 装饰元素配置
// ============================================================================
// 将 slideMasters.ts 中的光晕/线条/强调元素提取为配置对象，
// 不同主题/风格只需切换配置。
// ============================================================================

import type { ThemeConfig } from './types';

// ============================================================================
// Decoration Types
// ============================================================================

interface GlowDecoration {
  x: number; y: number; w: number; h: number;
  transparency: number;
  /** 填充色: 'accent'(默认) | 'background'(圆环镂空) */
  colorSource?: 'accent' | 'background';
}

interface LineDecoration {
  x: number; y: number; w: number; h: number;
  transparency?: number;
  /** 填充色: 'accent'(默认) | 'border'(分隔线) */
  colorSource?: 'accent' | 'border';
}

interface PanelDecoration {
  x: number; y: number; w: number; h: number;
  radius?: number;
  transparency?: number;
  /** 填充色: 'secondary'(默认) | 'accent'(强调面板) */
  colorSource?: 'secondary' | 'accent';
}

export interface MasterDecorationConfig {
  /** 光晕椭圆装饰 */
  glows: GlowDecoration[];
  /** 线条装饰（竖线、分隔线、强调线等） */
  lines: LineDecoration[];
  /** 面板/卡片装饰 */
  panels: PanelDecoration[];
}

// ============================================================================
// Decoration Budget - 装饰密度控制
// ============================================================================

interface DecorationBudget {
  maxGlows: number;
  maxLines: number;
  maxPanels: number;
  maxTotal: number;
}

const DEFAULT_BUDGET: DecorationBudget = { maxGlows: 3, maxLines: 4, maxPanels: 2, maxTotal: 7 };
const TITLE_BUDGET: DecorationBudget = { maxGlows: 3, maxLines: 4, maxPanels: 2, maxTotal: 8 };

/**
 * 强制执行装饰预算：逐类别截断 → 检查总量 → 超出时从 lines 优先裁剪
 */
function enforceDecorationBudget(
  config: MasterDecorationConfig,
  budget: DecorationBudget
): MasterDecorationConfig {
  const glows = config.glows.slice(0, budget.maxGlows);
  let lines = config.lines.slice(0, budget.maxLines);
  const panels = config.panels.slice(0, budget.maxPanels);

  // 检查总量，超出时从 lines（通常最多的类别）优先裁剪
  let total = glows.length + lines.length + panels.length;
  while (total > budget.maxTotal && lines.length > 0) {
    lines = lines.slice(0, lines.length - 1);
    total = glows.length + lines.length + panels.length;
  }

  return { glows, lines, panels };
}

// ============================================================================
// Decoration Builder
// ============================================================================

/**
 * 将 DecorationConfig 转换为 pptxgenjs 的 objects 数组
 */
export function buildDecorationObjects(
  config: MasterDecorationConfig,
  theme: ThemeConfig
): any[] {
  const objects: any[] = [];

  // Glows → ellipse
  for (const glow of config.glows) {
    const fillColor = glow.colorSource === 'background' ? theme.bgColor : theme.accent;
    objects.push({
      ellipse: {
        x: glow.x, y: glow.y, w: glow.w, h: glow.h,
        fill: { color: fillColor, transparency: glow.transparency },
      },
    });
  }

  // Lines → rect
  for (const line of config.lines) {
    const fillColor = line.colorSource === 'border' ? theme.cardBorder : theme.accent;
    objects.push({
      rect: {
        x: line.x, y: line.y, w: line.w, h: line.h,
        fill: { color: fillColor, transparency: line.transparency ?? 0 },
      },
    });
  }

  // Panels → rect with optional border
  for (const panel of config.panels) {
    const isAccent = panel.colorSource === 'accent';
    const fillColor = isAccent ? theme.accent : theme.bgSecondary;
    const obj: any = {
      rect: {
        x: panel.x, y: panel.y, w: panel.w, h: panel.h,
        fill: { color: fillColor, transparency: panel.transparency ?? 0 },
      },
    };
    if (!isAccent) {
      obj.rect.line = { color: theme.cardBorder, width: 0.5 };
    }
    if (panel.radius) {
      obj.rect.rectRadius = panel.radius;
    }
    objects.push(obj);
  }

  return objects;
}

// ============================================================================
// Decoration Presets - Apple Dark
// ============================================================================

const APPLE_TITLE: MasterDecorationConfig = {
  glows: [
    { x: 4, y: -3, w: 10, h: 10, transparency: 92 },   // 右上角大光晕
    { x: -4, y: 3, w: 8, h: 8, transparency: 96 },      // 左下角柔和光晕
  ],
  lines: [
    { x: 0.4, y: 2, w: 0.08, h: 1.8, transparency: 0 },   // 左侧强调竖条
    { x: 0.8, y: 3.5, w: 4, h: 0.04, transparency: 0 },    // 标题下方强调线
    { x: 4.8, y: 3.5, w: 1.5, h: 0.04, transparency: 60 }, // 淡化延伸线
    { x: 0.5, y: 5, w: 9, h: 0.01, colorSource: 'border' },// 底部分隔线
  ],
  panels: [],
};

const APPLE_CONTENT_LIST: MasterDecorationConfig = {
  glows: [
    { x: 6, y: -2, w: 7, h: 7, transparency: 94 },
    { x: -3, y: 3, w: 6, h: 6, transparency: 96 },
  ],
  lines: [
    { x: 0.4, y: 0.4, w: 0.06, h: 0.65, transparency: 0 },
  ],
  panels: [
    { x: 0.4, y: 1.35, w: 9.2, h: 4.0, radius: 0.2 },
  ],
};

const APPLE_CONTENT_CHART: MasterDecorationConfig = {
  glows: [
    { x: 6.5, y: -1, w: 6, h: 6, transparency: 95 },
  ],
  lines: [
    { x: 0.4, y: 0.4, w: 0.06, h: 0.65, transparency: 0 },
  ],
  panels: [
    { x: 0.4, y: 1.35, w: 4.3, h: 4.0, radius: 0.2 },
    { x: 4.9, y: 1.35, w: 4.7, h: 4.0, radius: 0.2 },
  ],
};

const APPLE_CONTENT_IMAGE: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.5, w: 0.06, h: 0.5, transparency: 0 },   // 标题左侧强调块
    { x: 0.6, y: 1.05, w: 1.5, h: 0.03, transparency: 0 },   // 标题下方装饰线
  ],
  panels: [],
};

const APPLE_HERO_NUMBER: MasterDecorationConfig = {
  glows: [
    { x: 5, y: -1, w: 8, h: 8, transparency: 95 },
    { x: -2, y: 3, w: 5, h: 5, transparency: 97 },
  ],
  lines: [
    { x: 0.4, y: 0.4, w: 0.06, h: 0.65, transparency: 0 },
  ],
  panels: [],
};

const APPLE_QUOTE: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 3.5, y: 4.2, w: 3, h: 0.02, transparency: 0 },
  ],
  panels: [],
};

const APPLE_COMPARISON: MasterDecorationConfig = {
  glows: [
    { x: 3, y: -2, w: 7, h: 7, transparency: 96 },
  ],
  lines: [
    { x: 0.4, y: 0.4, w: 0.06, h: 0.65, transparency: 0 },
  ],
  panels: [],
};

const APPLE_TWO_COL: MasterDecorationConfig = {
  glows: [
    { x: -2, y: -1, w: 6, h: 6, transparency: 96 },
  ],
  lines: [
    { x: 0.4, y: 0.4, w: 0.06, h: 0.65, transparency: 0 },
  ],
  panels: [
    { x: 0.4, y: 1.35, w: 9.2, h: 4.0, radius: 0.2 },
  ],
};

const APPLE_END: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 3.5, y: 3.3, w: 3, h: 0.02, transparency: 0 },       // 细横线
    { x: 0.5, y: 5, w: 9, h: 0.01, colorSource: 'border' },    // 底部分隔线
  ],
  panels: [],
};

// ============================================================================
// Decoration Presets - Default (Non-Apple)
// ============================================================================

const DEFAULT_TITLE: MasterDecorationConfig = {
  glows: [
    { x: 6, y: -1.5, w: 5, h: 5, transparency: 93 },                           // 右上角光晕
    { x: 6.5, y: -1, w: 4, h: 4, transparency: 0, colorSource: 'background' }, // 镂空
    { x: -2, y: 4, w: 6, h: 6, transparency: 95 },                              // 左下角光晕
  ],
  lines: [
    { x: 0.4, y: 2, w: 0.12, h: 1.8, transparency: 0 },       // 左侧强调竖条
    { x: 0.8, y: 3.5, w: 4, h: 0.04, transparency: 0 },        // 标题下方强调线
    { x: 0.5, y: 5, w: 9, h: 0.01, colorSource: 'border' },    // 底部分隔线
  ],
  panels: [],
};

const DEFAULT_CONTENT_LIST: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.4, w: 0.15, h: 0.65, transparency: 0 },
  ],
  panels: [
    { x: 0.4, y: 1.35, w: 9.2, h: 4.0, radius: 0.2 },
  ],
};

const DEFAULT_CONTENT_CHART: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.4, w: 0.15, h: 0.65, transparency: 0 },
  ],
  panels: [
    { x: 0.4, y: 1.35, w: 4.3, h: 4.0, radius: 0.2 },
    { x: 4.9, y: 1.35, w: 4.7, h: 4.0, radius: 0.2 },
  ],
};

const DEFAULT_CONTENT_IMAGE: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.5, w: 0.08, h: 0.5, transparency: 0 },   // 标题左侧强调块
    { x: 0.6, y: 1.05, w: 1.5, h: 0.03, transparency: 0 },   // 标题下方装饰线
  ],
  panels: [
    { x: 4.9, y: 1.2, w: 4.8, h: 4.0, radius: 0.1 },         // 右侧图片容器背景
  ],
};

const DEFAULT_HERO_NUMBER: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.4, w: 0.15, h: 0.65, transparency: 0 },
  ],
  panels: [],
};

const DEFAULT_QUOTE: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 3.5, y: 4.2, w: 3, h: 0.04, transparency: 0 },
  ],
  panels: [],
};

const DEFAULT_COMPARISON: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.4, w: 0.15, h: 0.65, transparency: 0 },
  ],
  panels: [],
};

const DEFAULT_TWO_COL: MasterDecorationConfig = {
  glows: [],
  lines: [
    { x: 0.4, y: 0.4, w: 0.15, h: 0.65, transparency: 0 },
  ],
  panels: [
    { x: 0.4, y: 1.35, w: 9.2, h: 4.0, radius: 0.2 },
  ],
};

const DEFAULT_END: MasterDecorationConfig = {
  glows: [
    { x: 4.5, y: 1, w: 6, h: 6, transparency: 96 },                          // 渐变圆环外层
    { x: 5, y: 1.5, w: 5, h: 5, transparency: 0, colorSource: 'background' }, // 圆环镂空
  ],
  lines: [
    { x: 4, y: 1.8, w: 2, h: 0.06, transparency: 0 },                        // 卡片顶部强调线
    { x: 3.5, y: 3.3, w: 3, h: 0.03, transparency: 0 },                      // 分隔装饰线
    { x: 0.5, y: 5, w: 9, h: 0.01, colorSource: 'border' },                  // 底部分隔线
  ],
  panels: [
    { x: 1.5, y: 1.8, w: 7, h: 2.6, radius: 0.2 },                           // 主内容卡片
  ],
};

// ============================================================================
// Master Decoration Registry
// ============================================================================

type MasterName = 'TITLE' | 'CONTENT_LIST' | 'CONTENT_CHART' | 'CONTENT_IMAGE' |
                  'END' | 'HERO_NUMBER' | 'QUOTE' | 'COMPARISON' | 'TWO_COL';

export const DECORATIONS: Record<string, Partial<Record<MasterName, MasterDecorationConfig>>> = {
  'apple': {
    TITLE: APPLE_TITLE,
    CONTENT_LIST: APPLE_CONTENT_LIST,
    CONTENT_CHART: APPLE_CONTENT_CHART,
    CONTENT_IMAGE: APPLE_CONTENT_IMAGE,
    HERO_NUMBER: APPLE_HERO_NUMBER,
    QUOTE: APPLE_QUOTE,
    COMPARISON: APPLE_COMPARISON,
    TWO_COL: APPLE_TWO_COL,
    END: APPLE_END,
  },
  'default': {
    TITLE: DEFAULT_TITLE,
    CONTENT_LIST: DEFAULT_CONTENT_LIST,
    CONTENT_CHART: DEFAULT_CONTENT_CHART,
    CONTENT_IMAGE: DEFAULT_CONTENT_IMAGE,
    HERO_NUMBER: DEFAULT_HERO_NUMBER,
    QUOTE: DEFAULT_QUOTE,
    COMPARISON: DEFAULT_COMPARISON,
    TWO_COL: DEFAULT_TWO_COL,
    END: DEFAULT_END,
  },
};

/**
 * 获取指定主题和 Master 的装饰配置（带预算控制）
 */
export function getDecorations(isApple: boolean, masterName: MasterName): MasterDecorationConfig {
  const style = isApple ? 'apple' : 'default';
  const config = DECORATIONS[style]?.[masterName] ?? { glows: [], lines: [], panels: [] };
  const budget = masterName === 'TITLE' ? TITLE_BUDGET : DEFAULT_BUDGET;
  return enforceDecorationBudget(config, budget);
}
