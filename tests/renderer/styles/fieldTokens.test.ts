// ============================================================================
// FB-216：Input/Select/Textarea 三个原语的底色与占位符色改用 --field-bg /
// --field-placeholder 令牌，四主题各自定值。dark / high-contrast-dark 令牌值
// 必须等于改前的 zinc-700 / zinc-500（深色观感不动）；light 为 #FFFFFF / #71717A
//（占位符对底色对比度 ≥ 4.5:1）；high-contrast-light 为 #FFFFFF / #606060。
// ============================================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const THEMES_DIR = path.resolve(__dirname, '../../../src/renderer/styles/themes');
const PRIMITIVES_DIR = path.resolve(__dirname, '../../../src/renderer/components/primitives');

const THEME_FILES = ['dark.css', 'light.css', 'high-contrast-dark.css', 'high-contrast-light.css'] as const;

function readTheme(file: string): string {
  return fs.readFileSync(path.join(THEMES_DIR, file), 'utf8');
}

function readToken(css: string, name: string): string | null {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(hexToRgb(fgHex));
  const l2 = relativeLuminance(hexToRgb(bgHex));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('field tokens（FB-216）', () => {
  it('四个主题都定义 --field-bg 与 --field-placeholder', () => {
    for (const file of THEME_FILES) {
      const css = readTheme(file);
      expect(readToken(css, '--field-bg'), `${file} --field-bg`).not.toBeNull();
      expect(readToken(css, '--field-placeholder'), `${file} --field-placeholder`).not.toBeNull();
    }
  });

  it('dark 与 high-contrast-dark 令牌值等于改前的 zinc-700 / zinc-500', () => {
    for (const file of ['dark.css', 'high-contrast-dark.css'] as const) {
      const css = readTheme(file);
      expect(readToken(css, '--field-bg'), `${file} --field-bg`).toBe('rgb(var(--zinc-700))');
      expect(readToken(css, '--field-placeholder'), `${file} --field-placeholder`).toBe('rgb(var(--zinc-500))');
    }
  });

  it('light 令牌为 #FFFFFF / #71717A，占位符对底色对比度 ≥ 4.5:1', () => {
    const css = readTheme('light.css');
    expect(readToken(css, '--field-bg')).toBe('#FFFFFF');
    expect(readToken(css, '--field-placeholder')).toBe('#71717A');
    expect(contrastRatio('#71717A', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('high-contrast-light 令牌为 #FFFFFF / #606060，对比度 ≥ 4.5:1', () => {
    const css = readTheme('high-contrast-light.css');
    expect(readToken(css, '--field-bg')).toBe('#FFFFFF');
    expect(readToken(css, '--field-placeholder')).toBe('#606060');
    expect(contrastRatio('#606060', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('Input/Select/Textarea 消费 --field-bg，Input/Textarea 消费 --field-placeholder', () => {
    for (const file of ['Input.tsx', 'Select.tsx', 'Textarea.tsx'] as const) {
      const source = fs.readFileSync(path.join(PRIMITIVES_DIR, file), 'utf8');
      expect(source, `${file} bg token`).toContain('bg-[var(--field-bg)]');
      expect(source, `${file} no hard-coded bg-zinc-700`).not.toContain('bg-zinc-700');
    }
    for (const file of ['Input.tsx', 'Textarea.tsx'] as const) {
      const source = fs.readFileSync(path.join(PRIMITIVES_DIR, file), 'utf8');
      expect(source, `${file} placeholder token`).toContain('placeholder:text-[var(--field-placeholder)]');
    }
  });
});
