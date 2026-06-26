// brandTheme：OKLCH→hex 转换 + 品牌契约→ThemeConfig 映射单测。
import { describe, expect, it } from 'vitest';
import {
  oklchToRgb,
  colorToHex6,
  rgbToHex6,
  themeConfigFromBrand,
} from '../../../../src/host/services/design/brandTheme';
import type { BrandContract } from '../../../../src/shared/contract/brandContract';

describe('oklchToRgb / colorToHex6', () => {
  it('精确锚点：纯黑 / 纯白', () => {
    expect(rgbToHex6(oklchToRgb('oklch(0% 0 0)')!)).toBe('000000');
    expect(rgbToHex6(oklchToRgb('oklch(100% 0 0)')!)).toBe('ffffff');
  });

  it('oklch 蓝紫色解析为合法 6 位 hex（非黑非白）', () => {
    const hex = colorToHex6('oklch(48% 0.14 268)', 'fallback');
    expect(hex).toMatch(/^[0-9a-f]{6}$/);
    expect(hex).not.toBe('000000');
    expect(hex).not.toBe('ffffff');
  });

  it('hex 直通（去 #，6 位）', () => {
    expect(colorToHex6('#3b82f6', 'x')).toBe('3b82f6');
    expect(colorToHex6('#fff', 'x')).toBe('ffffff');
  });

  it('rgb() 解析', () => {
    expect(colorToHex6('rgb(255, 0, 0)', 'x')).toBe('ff0000');
  });

  it('无法解析回退 fallback', () => {
    expect(colorToHex6('not-a-color', 'abcdef')).toBe('abcdef');
    expect(oklchToRgb('garbage')).toBeNull();
  });
});

describe('themeConfigFromBrand', () => {
  const brand = (palette: Record<string, string>): BrandContract =>
    ({
      id: 'b1',
      name: '测试品牌',
      tokens: {
        palette: { primary: '', surface: '', accent: '', muted: '', contrast: '', ...palette },
        fonts: { serif: 'Charter, serif', sans: 'Inter, sans-serif' },
        posture: '',
        refs: [],
      },
      keep: [],
      change: [],
      doNotCopy: [],
      source: 'manual',
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as BrandContract;

  it('浅色背景 → isDark=false，色板/字体注入', () => {
    const t = themeConfigFromBrand(
      brand({
        surface: 'oklch(98% 0.004 268)',
        contrast: 'oklch(18% 0.014 268)',
        accent: 'oklch(58% 0.18 282)',
        primary: 'oklch(48% 0.14 268)',
        muted: 'oklch(58% 0.018 268)',
      }),
    );
    expect(t.isDark).toBe(false);
    expect(t.bgColor).toMatch(/^[0-9a-f]{6}$/);
    expect(t.accent).toMatch(/^[0-9a-f]{6}$/);
    expect(t.fontTitle).toBe('Charter, serif');
    expect(t.fontBody).toBe('Inter, sans-serif');
    expect(t.name).toBe('测试品牌');
  });

  it('深色背景 → isDark=true', () => {
    const t = themeConfigFromBrand(brand({ surface: 'oklch(15% 0.01 268)' }));
    expect(t.isDark).toBe(true);
  });

  it('坏色板不崩，回退中性默认', () => {
    const t = themeConfigFromBrand(brand({ surface: 'xxx', accent: 'yyy' }));
    expect(t.bgColor).toMatch(/^[0-9a-f]{6}$/);
    expect(t.accent).toBe('3b82f6');
  });
});
