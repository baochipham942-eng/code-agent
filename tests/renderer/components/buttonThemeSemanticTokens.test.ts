import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { measureSecondaryButtonContrast } from '../../../scripts/check-design-system.mjs';

const readSource = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

const themeFiles = [
  'light.css',
  'dark.css',
  'high-contrast-light.css',
  'high-contrast-dark.css',
];

const secondaryTokens = [
  '--btn-secondary-bg',
  '--btn-secondary-fg',
  '--btn-secondary-bg-hover',
  '--btn-secondary-bg-disabled',
  '--btn-secondary-fg-disabled',
  '--btn-ghost-bg-hover',
];

type Rgb = [number, number, number];

const parseColor = (value: string): Rgb => {
  if (value.startsWith('#')) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ];
  }
  return value.trim().split(/\s+/).map(Number) as Rgb;
};

const readToken = (theme: string, token: string): Rgb => {
  const value = theme.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`Missing ${token}`);
  return parseColor(value);
};

const luminance = (color: Rgb): number => color
  .map((channel) => channel / 255)
  .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + [0.2126, 0.7152, 0.0722][index] * value, 0);

const contrast = (foreground: Rgb, background: Rgb): number => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

function makeThemeFixture(mutator: (css: string) => string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'button-theme-contrast-'));
  const themesRoot = join(fixtureRoot, 'styles/themes');
  mkdirSync(themesRoot, { recursive: true });
  for (const file of themeFiles) {
    const source = resolve(process.cwd(), 'src/renderer/styles/themes', file);
    const destination = join(themesRoot, file);
    copyFileSync(source, destination);
    if (file === 'light.css') {
      writeFileSync(destination, mutator(readFileSync(destination, 'utf8')));
    }
  }
  return fixtureRoot;
}

describe('secondary button theme tokens', () => {
  it('四套主题都定义 token，并在 Tailwind/Button 中走语义 utility', () => {
    const tailwind = readSource('tailwind.config.js');
    const button = readSource('src/renderer/components/primitives/Button.tsx');

    expect(tailwind).toContain("'btn-secondary': 'var(--btn-secondary-bg)'");
    expect(tailwind).toContain("'btn-secondary-hover': 'var(--btn-secondary-bg-hover)'");
    expect(tailwind).toContain("'btn-secondary-disabled': 'var(--btn-secondary-bg-disabled)'");
    expect(tailwind).toContain("'btn-secondary': 'var(--btn-secondary-fg)'");
    expect(tailwind).toContain("'btn-secondary-disabled': 'var(--btn-secondary-fg-disabled)'");
    expect(tailwind).toContain("'btn-ghost-hover': 'var(--btn-ghost-bg-hover)'");

    for (const file of themeFiles) {
      const theme = readSource(`src/renderer/styles/themes/${file}`);
      for (const token of secondaryTokens) {
        expect(theme, `${file} 缺少 ${token}`).toMatch(new RegExp(`${token}\\s*:`));
      }
      // 半透明 token 若以后引入，真实门必须能把它合成到这层；不许测试偷偷写死白/黑底。
      expect(theme).toContain('--bg-surface: #');
    }

    const secondary = button.match(/secondary:\s*\[[\s\S]*?\]\.join\(' '\)/)?.[0] ?? '';
    expect(secondary).toContain('bg-btn-secondary hover:bg-btn-secondary-hover');
    expect(secondary).toContain('text-btn-secondary');
    expect(secondary).toContain('disabled:bg-btn-secondary-disabled');
    expect(secondary).toContain('disabled:text-btn-secondary-disabled');
    expect(secondary).not.toContain('bg-zinc-600 hover:bg-zinc-500');
    expect(secondary).not.toContain('text-zinc-200');
  });

  it('按四套主题实际 token 真算三状态，并锁住 hover 可辨差异', () => {
    const measured = measureSecondaryButtonContrast();

    expect(measured.states).toHaveLength(12);
    expect(measured.hover).toHaveLength(4);
    expect(new Set(measured.states.map(({ theme }: { theme: string }) => theme))).toEqual(
      new Set(themeFiles.map((file) => file.replace('.css', ''))),
    );

    for (const result of measured.states as Array<{ ratio: number; theme: string; state: string }>) {
      expect(result.ratio, `${result.theme} ${result.state}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const result of measured.hover as Array<{ ratio: number; theme: string }>) {
      expect(result.ratio, `${result.theme} hover/启用`).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('变异：删主题 token、污染前景或抹平 hover 都会让同一测量转红', () => {
    const missingToken = makeThemeFixture((css) =>
      css.replace('  --btn-secondary-bg-hover: #C4C4C8;\n', ''),
    );
    const lowContrastForeground = makeThemeFixture((css) =>
      css.replace('--btn-secondary-fg: #27272A;', '--btn-secondary-fg: #FFFFFF;'),
    );
    const collapsedHover = makeThemeFixture((css) =>
      css.replace('--btn-secondary-bg-hover: #C4C4C8;', '--btn-secondary-bg-hover: #E4E4E7;'),
    );

    try {
      expect(() => measureSecondaryButtonContrast(missingToken)).toThrow(/--btn-secondary-bg-hover/);

      const lowContrast = measureSecondaryButtonContrast(lowContrastForeground);
      expect(lowContrast.states.find(({ theme, state }: { theme: string; state: string }) =>
        theme === 'light' && state === 'enabled')?.ratio).toBeLessThan(4.5);

      const collapsed = measureSecondaryButtonContrast(collapsedHover);
      expect(collapsed.hover.find(({ theme }: { theme: string }) => theme === 'light')?.ratio).toBeLessThan(1.2);
    } finally {
      rmSync(missingToken, { recursive: true, force: true });
      rmSync(lowContrastForeground, { recursive: true, force: true });
      rmSync(collapsedHover, { recursive: true, force: true });
    }
  });

  it('primary/danger hover 保持正文对比度，ghost 在四主题使用专用 hover 底', () => {
    const button = readSource('src/renderer/components/primitives/Button.tsx');

    expect(button).not.toContain('hover:to-primary-600');
    expect(button).toContain('hover:to-primary-700');
    expect(button).not.toContain('hover:bg-red-500');
    expect(button).toContain('hover:bg-red-700');
    expect(button).toContain('hover:bg-btn-ghost-hover');

    expect(contrast(parseColor('#FFFFFF'), parseColor('#0F766E'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor('#FFFFFF'), parseColor('#DC2626'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor('#FFFFFF'), parseColor('#B91C1C'))).toBeGreaterThanOrEqual(4.5);
    for (const file of themeFiles) {
      const theme = readSource(`src/renderer/styles/themes/${file}`);
      expect(
        contrast(readToken(theme, '--zinc-200'), readToken(theme, '--btn-ghost-bg-hover')),
        `${file} ghost hover`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
