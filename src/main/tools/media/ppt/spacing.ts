// ============================================================================
// PPT 主题感知间距配置
// ============================================================================

import type { ThemeConfig } from './types';
import { SLIDE } from './constants';

export interface SpacingConfig {
  /** Content area padding from slide edges (inches) */
  padding: { top: number; bottom: number; left: number; right: number };
  /** Gap between cards/elements (inches) */
  gap: number;
  /** Margin around card content (inches) */
  cardMargin: number;
  /** Line height multiplier */
  lineHeight: number;
  /** Min font size (pt) */
  minFontSize: number;
}

const SLIDE_WIDTH = SLIDE.WIDTH;
const SLIDE_HEIGHT = SLIDE.HEIGHT;

/**
 * Returns theme-aware spacing configuration.
 *
 * - Apple themes: tighter spacing for clean aesthetics
 * - Light themes: standard spacing with comfortable reading gaps
 * - Dark neon themes (default): generous spacing to accommodate glow effects
 */
export function getSpacingConfig(theme: ThemeConfig): SpacingConfig {
  const isApple = theme.name.includes('apple');
  const isAppleDark = isApple && theme.bgColor === '000000';

  if (isApple || isAppleDark) {
    return {
      padding: { top: 1.3, bottom: 0.5, left: 0.5, right: 0.5 },
      gap: 0.2,
      cardMargin: 0.15,
      lineHeight: 1.3,
      minFontSize: 11,
    };
  }

  if (!theme.isDark) {
    return {
      padding: { top: 1.3, bottom: 0.5, left: 0.5, right: 0.5 },
      gap: 0.25,
      cardMargin: 0.2,
      lineHeight: 1.4,
      minFontSize: 10,
    };
  }

  // Default: dark neon themes — generous spacing for glow effects
  return {
    padding: { top: 1.5, bottom: 0.5, left: 0.35, right: 0.35 },
    gap: 0.22,
    cardMargin: 0.15,
    lineHeight: 1.3,
    minFontSize: 10,
  };
}

/**
 * Returns the usable content area after subtracting padding from slide edges.
 */
export function getContentArea(spacing: SpacingConfig): { x: number; y: number; w: number; h: number } {
  const { padding } = spacing;
  return {
    x: padding.left,
    y: padding.top,
    w: SLIDE_WIDTH - padding.left - padding.right,
    h: SLIDE_HEIGHT - padding.top - padding.bottom,
  };
}
