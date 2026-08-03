import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { measureMarkContrast } from '../../../scripts/check-design-system.mjs';

const themeFiles = [
  'light.css',
  'dark.css',
  'high-contrast-light.css',
  'high-contrast-dark.css',
];

const markTokens = [
  '--mark-info',
  '--mark-success',
  '--mark-warning',
  '--mark-danger',
  '--mark-accent',
  '--mark-neutral',
];

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

function makeThemeFixture(mutator: (css: string) => string, fileToMutate = 'light.css'): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mark-theme-contrast-'));
  const themesRoot = join(fixtureRoot, 'styles/themes');
  mkdirSync(themesRoot, { recursive: true });
  for (const file of themeFiles) {
    const source = resolve(process.cwd(), 'src/renderer/styles/themes', file);
    const destination = join(themesRoot, file);
    copyFileSync(source, destination);
    if (file === fileToMutate) {
      writeFileSync(destination, mutator(readFileSync(destination, 'utf8')));
    }
  }
  return fixtureRoot;
}

describe('solid mark theme tokens', () => {
  it('defines independent mark utilities across all four themes', () => {
    const tailwind = readSource('tailwind.config.js');

    for (const [name, token] of markTokens.map((token) => [token.slice('--mark-'.length), token])) {
      expect(tailwind).toContain(`'mark-${name}': 'var(${token})'`);
      expect(tailwind).not.toContain(`'mark-${name}': 'var(--badge-`);
    }

    for (const file of themeFiles) {
      const theme = readSource(`src/renderer/styles/themes/${file}`);
      for (const token of markTokens) {
        expect(theme, `${file} 缺少 ${token}`).toMatch(new RegExp(`${token}\\s*:`));
      }
    }
  });

  it('按四套主题真实 surface 逐组核对比度，图形元素达到 3:1', () => {
    const measured = measureMarkContrast();

    expect(measured).toHaveLength(themeFiles.length * markTokens.length);
    expect(new Set(measured.map(({ theme }: { theme: string }) => theme))).toEqual(
      new Set(themeFiles.map((file) => file.replace('.css', ''))),
    );
    for (const result of measured as Array<{ ratio: number; theme: string; token: string }>) {
      expect(result.ratio, `${result.theme} ${result.token}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('变异：删任一主题定义或污染值都会让同一对比度测量转红', () => {
    const pollutedToken = makeThemeFixture(
      (css) => css.replace('--mark-danger: #B91C1C;', '--mark-danger: #FFFFFF;'),
      'light.css',
    );

    try {
      for (const file of themeFiles) {
        const missingToken = makeThemeFixture(
          (css) => css.replace(/\s*--mark-danger:\s*[^;]+;\n/, '\n'),
          file,
        );
        try {
          expect(() => measureMarkContrast(missingToken), `${file} 删除 mark token 后应转红`)
            .toThrow(/--mark-danger/);
        } finally {
          rmSync(missingToken, { recursive: true, force: true });
        }
      }
      const polluted = measureMarkContrast(pollutedToken);
      expect(polluted.find(({ theme, token }: { theme: string; token: string }) =>
        theme === 'light' && token === '--mark-danger')?.ratio).toBeLessThan(3);
    } finally {
      rmSync(pollutedToken, { recursive: true, force: true });
    }
  });
});
