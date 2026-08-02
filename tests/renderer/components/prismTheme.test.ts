// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// prismTheme 测试:主题→palette 映射 + data-theme 订阅 + 高对比 AAA 对比度钉死。
// 沿用 useTheme.test.tsx 的 per-file jsdom pragma(不动全局 environment:node)。
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { a11yDark, oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  getPrismStyleForTheme,
  usePrismStyle,
  type PrismStyle,
} from '../../../src/renderer/components/features/chat/MessageBubble/prismTheme';

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as Rgb;
};

const luminance = ([r, g, b]: Rgb): number => {
  const channels = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (fg: Rgb, bg: Rgb): number => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

/** 收集 style 里所有前景色,转成 RGB;跳过 inherit / hsla(半透明 selection 底色)等非前景值。 */
const collectForegrounds = (style: PrismStyle): Array<[string, Rgb]> => {
  const out: Array<[string, Rgb]> = [];
  for (const [selector, value] of Object.entries(style)) {
    const color = value && typeof value === 'object'
      ? (value as { color?: unknown }).color
      : undefined;
    if (typeof color !== 'string') continue;
    if (/^#[0-9a-fA-F]{6}$/.test(color)) out.push([selector, hexToRgb(color)]);
    else {
      const hsl = color.match(/^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/);
      if (hsl) out.push([selector, hslToRgb(+hsl[1], +hsl[2], +hsl[3])]);
    }
  }
  return out;
};

const readCodeBg = (themeFile: string): Rgb => {
  const css = readFileSync(resolve(process.cwd(), `src/renderer/styles/themes/${themeFile}`), 'utf8');
  const hex = css.match(/--code-bg:\s*(#[0-9A-F]{6})/i)?.[1];
  if (!hex) throw new Error(`${themeFile} 缺少 --code-bg hex 定义`);
  return hexToRgb(hex);
};

describe('getPrismStyleForTheme 映射', () => {
  it('dark / 未知 / 缺省 → oneDark(现状保持)', () => {
    expect(getPrismStyleForTheme('dark')).toBe(oneDark);
    expect(getPrismStyleForTheme(null)).toBe(oneDark);
    expect(getPrismStyleForTheme('')).toBe(oneDark);
    expect(getPrismStyleForTheme('something-else')).toBe(oneDark);
  });

  it('light → oneLight', () => {
    expect(getPrismStyleForTheme('light')).toBe(oneLight);
  });

  it('high-contrast-dark → a11yDark', () => {
    expect(getPrismStyleForTheme('high-contrast-dark')).toBe(a11yDark);
  });

  it('high-contrast-light → oneLight 基础上的 AAA 覆盖(不是原样 oneLight)', () => {
    const style = getPrismStyleForTheme('high-contrast-light');
    expect(style).not.toBe(oneLight);
    // oneLight 的 comment 原是 hsl(230, 4%, 64%)(2.4:1),必须被换成 AAA 深色
    expect((style.comment as { color: string }).color).toBe('#374151');
  });
});

describe('高对比 palette 达 WCAG AAA(≥7:1,对各自主题 --code-bg)', () => {
  it.each([
    ['high-contrast-dark', 'high-contrast-dark.css'],
    ['high-contrast-light', 'high-contrast-light.css'],
  ] as const)('%s 全部 token 前景色 ≥ 7:1', (theme, themeFile) => {
    const style = getPrismStyleForTheme(theme);
    const bg = readCodeBg(themeFile);
    const foregrounds = collectForegrounds(style);
    expect(foregrounds.length).toBeGreaterThan(10);
    const failures = foregrounds
      .map(([selector, rgb]) => ({ selector, ratio: contrast(rgb, bg) }))
      .filter(({ ratio }) => ratio < 7);
    expect(failures).toEqual([]);
  });
});

describe('usePrismStyle 订阅 <html data-theme>', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('无 data-theme 时回退 oneDark(仓默认主题)', () => {
    const { result } = renderHook(() => usePrismStyle());
    expect(result.current).toBe(oneDark);
  });

  it('按当前 data-theme 取 palette,属性变化时跟随切换', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { result } = renderHook(() => usePrismStyle());
    expect(result.current).toBe(oneLight);

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    expect(result.current).toBe(oneDark);

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'high-contrast-dark');
    });
    expect(result.current).toBe(a11yDark);
  });
});
