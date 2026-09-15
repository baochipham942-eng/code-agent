import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { findStickyInPaddedScrollerViolations, findThemeBlindBrightForegroundMatches, findThemeBlindBrightForegroundViolations, findThemeBlindWhiteHoverForegroundMatches, findThemeBlindWhiteHoverForegroundViolations, scan } from '../../scripts/check-design-system.mjs';

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
  it('匹配任意色板，拦没有 dark: 变体的亮档彩色前景类，并保留完整类名', () => {
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

  it('只对有主题变量支撑的 zinc 做全局豁免，其他色板仍需逐处判断', () => {
    expect(
      findThemeBlindBrightForegroundViolations(
        'text-zinc-300 text-cyan-300 text-gray-300 text-brand-300',
        'Fixture.tsx:8',
      ),
    ).toEqual([
      'Fixture.tsx:8 text-cyan-300',
      'Fixture.tsx:8 text-gray-300',
      'Fixture.tsx:8 text-brand-300',
    ]);
  });

  it('沿用 ds-allow:color: 理由注释放行，其他规则的注释不串门', () => {
    expect(
      findThemeBlindBrightForegroundViolations(
        'text-sky-300 /* ds-allow:color: 深色画布固定底色 */',
        'Fixture.tsx:9',
      ),
    ).toEqual([]);
    expect(
      findThemeBlindBrightForegroundViolations(
        'text-sky-300 /* ds-allow:button: 这是按钮布局例外 */',
        'Fixture.tsx:10',
      ),
    ).toEqual(['Fixture.tsx:10 text-sky-300']);
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

describe('theme-blind white hover foreground gate', () => {
  it('拦无主题分支的 hover 白色，覆盖普通、group 与透明度写法', () => {
    expect(
      findThemeBlindWhiteHoverForegroundMatches(
        'text-white hover:text-white group-hover:text-white/80 dark:hover:text-white focus:text-white',
      ),
    ).toEqual([
      { className: 'text-white', coreClass: 'text-white' },
      { className: 'hover:text-white', coreClass: 'text-white' },
      { className: 'group-hover:text-white/80', coreClass: 'text-white/80' },
      { className: 'dark:hover:text-white', coreClass: 'text-white' },
      { className: 'focus:text-white', coreClass: 'text-white' },
    ]);
    expect(
      findThemeBlindWhiteHoverForegroundViolations(
        'text-white hover:text-white group-hover:text-white/80 dark:hover:text-white focus:text-white',
        'Fixture.tsx:11',
      ),
    ).toEqual([
      'Fixture.tsx:11 hover:text-white',
      'Fixture.tsx:11 group-hover:text-white/80',
    ]);
  });

  it('固定深色背景可用 ds-allow:color 写明理由后放行', () => {
    expect(
      findThemeBlindWhiteHoverForegroundViolations(
        'bg-black/80 hover:text-white /* ds-allow:color: 固定深色遮罩 */',
        'Fixture.tsx:12',
      ),
    ).toEqual([]);
  });
});

describe('sticky-in-padded-scroller gate（FB-162）', () => {
  const padded = [
    '<div className="min-h-0 flex-1 overflow-auto px-3 py-2">',
    '  <table>',
    '    <thead className="sticky top-0 z-10 bg-zinc-950">',
    '    </thead>',
    '  </table>',
    '</div>',
  ];
  it('滚动容器带 py-2 且内含 sticky top-0 ⇒ 违规并指出容器行', () => {
    expect(findStickyInPaddedScrollerViolations(padded, 'F.tsx')).toEqual(['F.tsx:3 滚动容器 F.tsx:1 带上内边距']);
  });
  it('滚动容器只有 pb/px ⇒ 不违规；pt-[N] 也算上内边距', () => {
    expect(findStickyInPaddedScrollerViolations(padded.map((l) => l.replace('py-2', 'pb-2')), 'F.tsx')).toEqual([]);
    expect(findStickyInPaddedScrollerViolations(padded.map((l) => l.replace('py-2', 'pt-[6px]')), 'F.tsx')).toHaveLength(1);
  });
  it('pt-0 / py-0 / scroll-pt-* 不算上内边距；pt-1.5 算', () => {
    for (const cls of ['pt-0', 'py-0', 'scroll-pt-4']) {
      expect(findStickyInPaddedScrollerViolations(padded.map((l) => l.replace('py-2', cls)), 'F.tsx')).toEqual([]);
    }
    for (const cls of ['pt-1.5', 'pt-0.5', 'py-0.5']) {
      expect(findStickyInPaddedScrollerViolations(padded.map((l) => l.replace('py-2', cls)), 'F.tsx'), cls).toHaveLength(1);
    }
  });

  it('ds-allow:sticky 写在 sticky 行或容器行都放行', () => {
    expect(findStickyInPaddedScrollerViolations(padded.map((l) => l.replace('bg-zinc-950">', 'bg-zinc-950"> {/* ds-allow:sticky 理由 */}')), 'F.tsx')).toEqual([]);
  });
  it('只认更浅缩进的祖先：同级兄弟的滚动容器不算', () => {
    const sibling = [
      '<div>',
      '  <div className="overflow-auto py-2" />',
      '  <div className="overflow-auto">',
      '    <thead className="sticky top-0" />',
      '  </div>',
      '</div>',
    ];
    expect(findStickyInPaddedScrollerViolations(sibling, 'F.tsx')).toEqual([]);
  });
});
