import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { compareBundles, firstDiffBlock, hashBundle, normalizeBundle, parseArgs, scanForPattern } from '../../scripts/check-refactor-bundle-identical.mjs';

const fixtures = resolve('tests/fixtures/refactor-bundle');
const entry = 'entry.js';

describe('check-refactor-bundle-identical helpers', () => {
  it('parses the entry, default base, repeatable expectations, and usage errors', () => {
    expect(parseArgs(['entry.js'])).toEqual({
      entry: 'entry.js',
      base: 'origin/main',
      expects: [],
    });
    expect(parseArgs(['entry.js', '--base', 'HEAD~1', '--expect', 'moved', '--expect', '/stays/'])).toEqual({
      entry: 'entry.js',
      base: 'HEAD~1',
      expects: ['moved', '/stays/'],
    });
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(() => parseArgs([])).toThrow(/entry path is required/);
    expect(() => parseArgs(['entry.js', '--unknown'])).toThrow(/unknown option/);
  });

  it('normalizes only esbuild module path comments and hashes deterministically', () => {
    const bundle = 'before\n\n// /tmp/source.js\nmodule();\n// keep this comment\n';
    expect(normalizeBundle(bundle)).toBe('before\nmodule();\n// keep this comment\n');
    expect(hashBundle('same')).toBe(hashBundle('same'));
    expect(hashBundle('same')).not.toBe(hashBundle('changed'));
  });

  it('reports a first differing line with nearby context', () => {
    expect(firstDiffBlock('a\nb\nc\nd', 'a\nb\nchanged\nd')).toContain('first differing line: 3');
    expect(firstDiffBlock('same', 'same')).toBeNull();
    expect(firstDiffBlock('same', 'same\nextra')).toContain('<EOF>');
  });

  it('throws when a source scan pattern has zero hits', () => {
    expect(scanForPattern('moved stays', /moved/)).toBe(1);
    expect(() => scanForPattern('moved stays', /missing/)).toThrow(/zero hits/);
  });

  it('terminates when a global expect regex can match zero-width text', () => {
    // 回归：零宽匹配在 lastIndex>0 处不推进 exec 游标，旧守卫只兜 lastIndex===0，会原地死循环。
    // 故意放在子进程里跑并给超时：复现时挂死的是被 kill 的子进程，测试红而不是整个套件僵死。
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { scanForPattern } from ${JSON.stringify(pathToFileURL(resolve('scripts/check-refactor-bundle-identical.mjs')).href)};\nconsole.log('hits=' + scanForPattern('stay stays', /(?:stay)*/g));`,
    ], { encoding: 'utf8', timeout: 10_000 });
    expect(probe.error, `scanForPattern did not terminate (signal=${probe.signal ?? 'none'}): ${probe.stderr}`).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(probe.stdout).toMatch(/^hits=\d+$/m);
  });
});

describe('refactor bundle comparison fixtures', () => {
  it('gives an identical sha for a pure move split', () => {
    const result = compareBundles({
      entry,
      baseRoot: join(fixtures, 'before'),
      workRoot: join(fixtures, 'after'),
    });
    expect(result.identical).toBe(true);
    expect(result.baseSha).toBe(result.workSha);
    expect(result.diff).toBeNull();
  });

  it('reports a different sha and a first diff when one literal changes', () => {
    const result = compareBundles({
      entry,
      baseRoot: join(fixtures, 'before'),
      workRoot: join(fixtures, 'after-mutated'),
    });
    expect(result.identical).toBe(false);
    expect(result.baseSha).not.toBe(result.workSha);
    expect(result.diff).toContain('moved-mutated');
  });

  it('scans reachable fixture source text with the same fail-loud contract', () => {
    const source = [
      readFileSync(join(fixtures, 'after', 'entry.js'), 'utf8'),
      readFileSync(join(fixtures, 'after', 'moved.js'), 'utf8'),
    ].join('\n');
    expect(scanForPattern(source, /moved/)).toBeGreaterThan(0);
    expect(() => scanForPattern(source, /absent-marker/)).toThrow(/zero hits/);
  });
});
