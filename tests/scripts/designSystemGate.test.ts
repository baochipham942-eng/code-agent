import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { findThemeBlindBrightForegroundMatches, findThemeBlindBrightForegroundViolations, scan } from '../../scripts/check-design-system.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(here, '../../scripts/design-system-baseline.json'), 'utf8'),
);

// 设计系统棘轮门（W2）——契约见 docs/designs/design-system.md
// 守约：禁止引入超出基线的新违规；收口（current < baseline）后须 `--update` 降棘轮。
describe('design-system gate', () => {
  const violations = scan() as Record<string, string[]>;

  for (const rule of Object.keys(baseline)) {
    it(`[${rule}] 不超基线（${baseline[rule]}）`, () => {
      const current = violations[rule]?.length ?? 0;
      expect(
        current,
        current > baseline[rule]
          ? `新增 ${current - baseline[rule]} 处违规：走 token/primitive，或加 // ds-allow:<kind> 理由。\n` +
              violations[rule].slice(0, 10).join('\n')
          : undefined,
      ).toBeLessThanOrEqual(baseline[rule]);
    });
  }
});

describe('theme-blind bright foreground gate', () => {
  it('只拦没有 dark: 变体的亮档彩色前景类，并保留完整类名', () => {
    expect(
      findThemeBlindBrightForegroundMatches('text-sky-300 dark:hover:text-blue-300 hover:text-red-400'),
    ).toEqual([
      { className: 'text-sky-300', coreClass: 'text-sky-300' },
      { className: 'dark:hover:text-blue-300', coreClass: 'text-blue-300' },
      { className: 'hover:text-red-400', coreClass: 'text-red-400' },
    ]);
    expect(
      findThemeBlindBrightForegroundViolations(
        'text-sky-300 dark:hover:text-blue-300 hover:text-red-400',
        'Fixture.tsx:7',
      ),
    ).toEqual(['Fixture.tsx:7 text-sky-300', 'Fixture.tsx:7 hover:text-red-400']);
  });

  it('沿用 ds-allow:color: 理由注释放行，其他规则的注释不串门', () => {
    expect(
      findThemeBlindBrightForegroundViolations(
        'text-sky-300 /* ds-allow:color: 深色画布固定底色 */',
        'Fixture.tsx:8',
      ),
    ).toEqual([]);
    expect(
      findThemeBlindBrightForegroundViolations(
        'text-sky-300 /* ds-allow:button: 这是按钮布局例外 */',
        'Fixture.tsx:9',
      ),
    ).toEqual(['Fixture.tsx:9 text-sky-300']);
  });

  it('扫描根不存在时 fail loud', () => {
    const missingRoot = join(tmpdir(), `check-design-system-missing-${process.pid}`);
    expect(() => scan(missingRoot)).toThrow(/扫描根不存在/);
  });

  it('正则没有命中目标时 fail loud', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'check-design-system-no-target-'));
    try {
      writeFileSync(join(fixtureRoot, 'sample.tsx'), 'export const sample = 1;\n');
      writeFileSync(join(fixtureRoot, 'theme.css'), ':root {}\n');
      expect(() => scan(fixtureRoot)).toThrow(/亮档彩色前景扫描没有命中任何目标/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
