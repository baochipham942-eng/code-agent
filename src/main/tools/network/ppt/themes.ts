// ============================================================================
// PPT 主题配置 - 2026 设计标准
// ============================================================================

import type { PPTTheme, ThemeConfig } from './types';

// 9 种配色主题（含 apple-dark）
export const THEME_CONFIGS: Record<PPTTheme, ThemeConfig> = {
  'neon-green': {
    name: '霓虹绿',
    bgColor: '0a0a0a',
    bgSecondary: '141414',
    textPrimary: 'f0f0f0',
    textSecondary: '888888',
    accent: '00ff88',
    accentGlow: '4fffb0',
    cardBorder: '1a1a1a',
    isDark: true,
    fontTitle: 'Arial Black',
    fontBody: 'Arial',
    fontCode: 'Consolas',
  },
  'neon-blue': {
    name: '电光蓝',
    bgColor: '0a0f1a',
    bgSecondary: '111827',
    textPrimary: 'f8fafc',
    textSecondary: '94a3b8',
    accent: '00d4ff',
    accentGlow: '67e8f9',
    cardBorder: '1e293b',
    isDark: true,
    fontTitle: 'Arial Black',
    fontBody: 'Arial',
    fontCode: 'Consolas',
  },
  'neon-purple': {
    name: '霓虹紫',
    bgColor: '0f0a1a',
    bgSecondary: '1a1025',
    textPrimary: 'faf5ff',
    textSecondary: 'a78bfa',
    accent: 'c084fc',
    accentGlow: 'e879f9',
    cardBorder: '2e1065',
    isDark: true,
    fontTitle: 'Arial Black',
    fontBody: 'Arial',
    fontCode: 'Fira Code',
  },
  'neon-orange': {
    name: '霓虹橙',
    bgColor: '1a1410',
    bgSecondary: '27211a',
    textPrimary: 'fef3c7',
    textSecondary: 'fbbf24',
    accent: 'ff6b00',
    accentGlow: 'fb923c',
    cardBorder: '44403c',
    isDark: true,
    fontTitle: 'Arial Black',
    fontBody: 'Arial',
    fontCode: 'Consolas',
  },
  'glass-light': {
    name: '玻璃浅色',
    bgColor: 'f8fafc',
    bgSecondary: 'ffffff',
    textPrimary: '0f172a',
    textSecondary: '64748b',
    accent: '3b82f6',
    accentGlow: '60a5fa',
    cardBorder: 'e2e8f0',
    isDark: false,
    fontTitle: 'Arial',
    fontBody: 'Arial',
    fontCode: 'Monaco',
  },
  'glass-dark': {
    name: '玻璃深色',
    bgColor: '18181b',
    bgSecondary: '27272a',
    textPrimary: 'fafafa',
    textSecondary: 'a1a1aa',
    accent: '8b5cf6',
    accentGlow: 'a78bfa',
    cardBorder: '3f3f46',
    isDark: true,
    fontTitle: 'Arial',
    fontBody: 'Arial',
    fontCode: 'Fira Code',
  },
  'minimal-mono': {
    name: '极简黑白',
    bgColor: 'ffffff',
    bgSecondary: 'fafafa',
    textPrimary: '000000',
    textSecondary: '525252',
    accent: '000000',
    accentGlow: '404040',
    cardBorder: 'e5e5e5',
    isDark: false,
    fontTitle: 'Helvetica',
    fontBody: 'Helvetica',
    fontCode: 'Monaco',
  },
  'corporate': {
    name: '企业蓝',
    bgColor: 'ffffff',
    bgSecondary: 'f1f5f9',
    textPrimary: '0f172a',
    textSecondary: '475569',
    accent: '1e40af',
    accentGlow: '3b82f6',
    cardBorder: 'cbd5e1',
    isDark: false,
    fontTitle: 'Georgia',
    fontBody: 'Arial',
    fontCode: 'Courier New',
  },
  'apple-dark': {
    name: '苹果暗黑',
    bgColor: '000000',
    bgSecondary: '1c1c1e',
    textPrimary: 'f5f5f7',
    textSecondary: '86868b',
    accent: '0071e3',
    accentGlow: '2997ff',
    cardBorder: '38383a',
    isDark: true,
    fontTitle: 'Helvetica Neue',
    fontBody: 'Helvetica Neue',
    fontCode: 'SF Mono',
  },
};

/**
 * 获取主题配置，找不到则回退到 neon-green
 */
export function getThemeConfig(theme: string): ThemeConfig {
  return THEME_CONFIGS[theme as PPTTheme] || THEME_CONFIGS['neon-green'];
}

/**
 * 判断是否为 apple-dark 纯黑主题
 */
export function isAppleDark(theme: ThemeConfig): boolean {
  return theme.bgColor === '000000';
}
