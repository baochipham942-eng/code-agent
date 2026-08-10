import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { ANCHOR, TEST_ONLY_ANCHOR, findBaselineDelta, findNewStrictlyUnreachable, parseArgs, parseKnipResult, readBaseline, validateConfig } from '../../scripts/knip-production-ratchet.mjs';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function knipResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    signal: null,
    error: undefined,
    stderr: '',
    stdout: JSON.stringify({
      issues: [
        { file: ANCHOR, files: [{ name: ANCHOR }] },
        { file: TEST_ONLY_ANCHOR, files: [{ name: TEST_ONLY_ANCHOR }] },
        { file: 'src/example/dead.ts', files: [{ name: 'src/example/dead.ts' }] },
      ],
    }),
    ...overrides,
  };
}

describe('knip production ratchet fail-loud parsing', () => {
  it('accepts Knip exit 1 when the JSON report is healthy', () => {
    expect(parseKnipResult(knipResult(), 'knip.test.json')).toEqual([
      'src/example/dead.ts',
      TEST_ONLY_ANCHOR,
      ANCHOR,
    ]);
  });

  it('rejects a parseable report when Knip also emitted a config error', () => {
    expect(() => parseKnipResult(knipResult({
      stderr: 'ERROR: Error loading vitest.config.ts (Cannot find module vitest/config)',
    }), 'knip.test.json')).toThrow(/stderr 含工具\/配置错误/);
  });

  it('rejects an empty scan instead of treating zero as green', () => {
    expect(() => parseKnipResult(knipResult({
      status: 0,
      stdout: JSON.stringify({ issues: [] }),
    }), 'knip.test.json')).toThrow(/生产不可达文件数为 0/);
  });

  it('rejects a report when the known unreachable anchor disappears', () => {
    expect(() => parseKnipResult(knipResult({
      stdout: JSON.stringify({ issues: [{ file: 'src/example/dead.ts' }] }),
    }), 'knip.test.json')).toThrow(/锚点/);
  });

  it('rejects a report when test entries pollute the strict reachability graph', () => {
    expect(() => parseKnipResult(knipResult({
      stdout: JSON.stringify({ issues: [{ file: ANCHOR }] }),
    }), 'knip.production-strict.json')).toThrow(new RegExp(TEST_ONLY_ANCHOR));
  });

  it('rejects broken JSON config before spawning Knip', () => {
    const root = mkdtempSync(join(tmpdir(), 'knip-production-config-'));
    tempRoots.push(root);
    const configPath = join(root, 'broken.json');
    writeFileSync(configPath, '{not-json', 'utf8');

    expect(() => validateConfig(configPath)).toThrow(/不是合法 JSON/);
  });
});

describe('strict incremental reachability', () => {
  it('blocks only newly added files that are strictly unreachable', () => {
    expect(findNewStrictlyUnreachable(
      [ANCHOR, 'src/example/new-dead.ts', 'src/example/old-dead.ts'],
      ['src/example/live.ts', 'src/example/new-dead.ts'],
    )).toEqual(['src/example/new-dead.ts']);
  });
});

describe('legacy set reachability', () => {
  it('blocks a newly unreachable file even when a stored file is cleaned in the same change', () => {
    expect(findBaselineDelta(
      ['src/example/newly-unreachable.ts', 'src/example/unchanged.ts'],
      ['src/example/cleaned.ts', 'src/example/unchanged.ts'],
    )).toEqual({
      added: ['src/example/newly-unreachable.ts'],
      removed: ['src/example/cleaned.ts'],
    });
  });

  it('rejects malformed, duplicate, or unordered baselines before accepting a green result', () => {
    const root = mkdtempSync(join(tmpdir(), 'knip-production-baseline-'));
    tempRoots.push(root);
    const baselinePath = join(root, 'baseline.json');

    writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, files: ['src/z.ts', 'src/a.ts'] }), 'utf8');
    expect(() => readBaseline(baselinePath)).toThrow(/稳定排序/);

    writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, files: ['src/a.ts', 'src/a.ts'] }), 'utf8');
    expect(() => readBaseline(baselinePath)).toThrow(/不含重复路径/);
  });

  it('accepts only the explicit baseline update command', () => {
    expect(parseArgs([])).toEqual({ updateBaseline: false });
    expect(parseArgs(['--update-baseline'])).toEqual({ updateBaseline: true });
    expect(() => parseArgs(['--unknown'])).toThrow(/不支持的参数/);
  });
});
