import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NINE_FIFTY_TIER_MIN_LINES,
  buildNineFiftyTier,
  extractMaxLinesOffWhitelist,
  flatConfigGlobToRegExp,
  parseMaxLinesCounts,
} from '../../scripts/lib/eslint-ratchet-950-tier.mjs';

// 950-tier 早 warn（N-MAXLINES-MINEFIELD-2）：有效行 ≥950 且不在 God File 白名单
// 的文件只报告、不计数。这里测两层：helper 的纯逻辑（过滤/白名单/格式化），以及
// ratchet 脚本与主配置的特征断言（tier 真的接进了脚本、1000 硬限与警告基线没动）。

function eslintReportEntry(filePath: string, messages: Array<Record<string, unknown>>) {
  return { filePath, messages, errorCount: 0, warningCount: 0 };
}

function maxLinesMessage(lines: number) {
  return {
    ruleId: 'max-lines',
    severity: 2,
    message: `File has too many lines (${lines}). Maximum allowed is 949.`,
  };
}

describe('parseMaxLinesCounts', () => {
  it('只取 max-lines 计数，行数降序、同数按路径字典序', () => {
    const counts = parseMaxLinesCounts([
      eslintReportEntry('/repo/src/b.ts', [maxLinesMessage(960), { ruleId: 'no-console', severity: 1, message: 'unexpected console' }]),
      eslintReportEntry('/repo/src/a.ts', [maxLinesMessage(1001)]),
      eslintReportEntry('/repo/src/c.ts', [maxLinesMessage(960)]),
    ]);
    expect(counts).toEqual([
      { file: '/repo/src/a.ts', lines: 1001 },
      { file: '/repo/src/b.ts', lines: 960 },
      { file: '/repo/src/c.ts', lines: 960 },
    ]);
  });

  it('坏形状条目跳过而不是抛', () => {
    expect(parseMaxLinesCounts(null)).toEqual([]);
    expect(parseMaxLinesCounts([null, 42, { messages: 'x' }])).toEqual([]);
    expect(parseMaxLinesCounts([
      eslintReportEntry('/repo/src/a.ts', [{ ruleId: 'max-lines', message: 'malformed, no count' }]),
    ])).toEqual([]);
  });
});

describe('extractMaxLinesOffWhitelist', () => {
  it('只收 rules[max-lines] === off 条目的 files', () => {
    const patterns = extractMaxLinesOffWhitelist([
      { files: ['src/**'], rules: { 'max-lines': 'error' } },
      { files: ['src/host/a.ts', 'src/host/b.ts'], rules: { 'max-lines': 'off' } },
      { rules: { 'max-lines': 'off' } },
      null,
    ]);
    expect(patterns).toEqual(['src/host/a.ts', 'src/host/b.ts']);
  });
});

describe('flatConfigGlobToRegExp', () => {
  it('精确路径、段内 *、跨段 ** 各自匹配且不越界', () => {
    expect(flatConfigGlobToRegExp('src/host/a.ts').test('src/host/a.ts')).toBe(true);
    expect(flatConfigGlobToRegExp('src/host/a.ts').test('src/host/a.tsx')).toBe(false);
    expect(flatConfigGlobToRegExp('src/host/a.ts').test('xsrc/host/a.ts')).toBe(false);
    expect(flatConfigGlobToRegExp('src/*/a.ts').test('src/host/a.ts')).toBe(true);
    expect(flatConfigGlobToRegExp('src/*/a.ts').test('src/host/deep/a.ts')).toBe(false);
    expect(flatConfigGlobToRegExp('src/**/*.ts').test('src/a/b/c/d.ts')).toBe(true);
    expect(flatConfigGlobToRegExp('src/**/*.ts').test('out/src/a.ts')).toBe(false);
  });
});

describe('buildNineFiftyTier', () => {
  it('阈值边界取 ≥950，白名单与 repoRoot 前缀都生效', () => {
    const { entries, outputLines } = buildNineFiftyTier({
      repoRoot: '/repo',
      counts: [
        { file: '/repo/src/at-limit.ts', lines: NINE_FIFTY_TIER_MIN_LINES },
        { file: '/repo/src/below.ts', lines: NINE_FIFTY_TIER_MIN_LINES - 1 },
        { file: '/repo/src/god-table.ts', lines: 3261 },
        { file: '/repo/src/edge.tsx', lines: 1000 },
      ],
      whitelistPatterns: ['src/god-table.ts'],
    });
    expect(entries).toEqual([
      { file: 'src/edge.tsx', lines: 1000 },
      { file: 'src/at-limit.ts', lines: 950 },
    ]);
    expect(outputLines[0]).toContain('approaching the limit; the next person to edit this file will turn red');
    expect(outputLines[0]).toContain('950-tier');
    expect(outputLines.slice(1)).toEqual(['  src/edge.tsx (1000)', '  src/at-limit.ts (950)']);
  });

  it('白名单通配模式能排除目录整棵子树', () => {
    const { entries } = buildNineFiftyTier({
      counts: [
        { file: 'src/host/services/skills/data.ts', lines: 2469 },
        { file: 'src/host/services/keep.ts', lines: 990 },
      ],
      whitelistPatterns: ['src/host/services/skills/**'],
    });
    expect(entries).toEqual([{ file: 'src/host/services/keep.ts', lines: 990 }]);
  });

  it('空名单也产出表头行，供 ratchet 稳定打印', () => {
    const { entries, outputLines } = buildNineFiftyTier({ counts: [], whitelistPatterns: [] });
    expect(entries).toEqual([]);
    expect(outputLines).toHaveLength(1);
    expect(outputLines[0]).toContain('0 个文件');
  });
});

describe('eslint-ratchet 950-tier 接线与不动项（特征断言）', () => {
  const ratchetSource = readFileSync(resolve('scripts/eslint-ratchet.mjs'), 'utf8');
  const eslintConfigSource = readFileSync(resolve('eslint.config.js'), 'utf8');

  it('ratchet 真的接了 tier helper 并在两个出口都打印（删掉 tier 逻辑此测试必红）', () => {
    expect(ratchetSource).toMatch(/from '\.\/lib\/eslint-ratchet-950-tier\.mjs'/);
    expect(ratchetSource).toMatch(/buildNineFiftyTier/);
    expect(ratchetSource).toMatch(/scripts\/eslint-ratchet-950\.config\.mjs/);
    // breach 路径（process.exit(1) 紧跟前）与通过路径各打印一次
    const printCalls = ratchetSource.match(/printNineFiftyTier\(\);/g) ?? [];
    expect(printCalls.length).toBe(2);
    expect(ratchetSource).toMatch(/printNineFiftyTier\(\);\n {2}process\.exit\(1\);/);
  });

  it('tier 是独立第二遍，不做成主配置里的 max-lines warning', () => {
    // eslint.config.js 里 max-lines 只允许出现一次（error、1000），防止把 950-tier
    // 塞进主配置导致 950-1000 段文件全部计入警告基线。
    const maxLinesOccurrences = eslintConfigSource.match(/'max-lines'/g) ?? [];
    expect(maxLinesOccurrences.length).toBe(2); // 主规则 error + 白名单 off
    expect(eslintConfigSource).toMatch(/'max-lines': \['error', \{ max: 1000, skipBlankLines: true, skipComments: true \}\]/);
  });

  it('1000 硬限与警告基线数字未被 tier 改动', () => {
    expect(ratchetSource).toMatch(/const BASELINE_WARNING_MAX = 376;/);
    expect(ratchetSource).toMatch(/const BASELINE_ERROR_MAX = 0;/);
  });
});
