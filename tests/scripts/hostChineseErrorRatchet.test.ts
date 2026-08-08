import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- 纯 JS 静态门脚本，无类型声明
import { BASELINE_MAX, assertHostChineseErrorBaseline, scanHostChineseErrorLiterals } from '../../scripts/host-chinese-error-ratchet.mjs';

type ScanReport = {
  fileCount: number;
  targetCount: number;
  findings: Array<{ file: string; line: number; column: number; preview: string }>;
};

describe('host 中文 error 字面量棘轮', () => {
  let repoRoot: string;
  let scanRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'host-chinese-error-ratchet-'));
    scanRoot = join(repoRoot, 'src/host/tools');
    mkdirSync(scanRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const scan = () => scanHostChineseErrorLiterals({
    repoRoot,
    roots: ['src/host/tools'],
  }) as ScanReport;

  it('识别 error 属性里的字符串、模板串、兜底表达式；每个属性只计一次', () => {
    writeFileSync(join(scanRoot, 'targets.ts'), [
      `const a = { error: '直接失败' };`,
      'const b = { error: `模板执行失败：${reason}` };',
      `const c = { 'error': upstream.error || '中文兜底失败' };`,
      `const d = { ['error']: flag ? '第一段失败' : '第二段失败' };`,
      `const ignored = { message: '不是 error 属性' };`,
      `const indirectMessage = '间接错误';`,
      `const indirect = { error: indirectMessage };`,
      `const english = { error: 'English only' };`,
      '',
    ].join('\n'));

    const report = scan();
    expect(report.fileCount).toBe(1);
    expect(report.targetCount).toBe(4);
    expect(report.findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4]);
  });

  it('变异链：新增一个命中使计数 +1 并失败，移除后恢复绿色', () => {
    writeFileSync(join(scanRoot, 'baseline.ts'), `export const baseline = { error: '已有失败' };\n`);
    const baseline = scan();
    expect(baseline.targetCount).toBe(1);
    expect(() => assertHostChineseErrorBaseline(baseline, 1)).not.toThrow();

    const mutationPath = join(scanRoot, 'mutation.ts');
    writeFileSync(mutationPath, `export const mutation = { error: '新增失败文案' };\n`);
    const mutated = scan();
    expect(mutated.targetCount).toBe(2);
    expect(() => assertHostChineseErrorBaseline(mutated, 1)).toThrow(/超基线 1 个/);

    unlinkSync(mutationPath);
    const recovered = scan();
    expect(recovered.targetCount).toBe(1);
    expect(() => assertHostChineseErrorBaseline(recovered, 1)).not.toThrow();
  });

  it('扫描根配置损坏或扫描 0 文件时 fail loud', () => {
    expect(() => scanHostChineseErrorLiterals({ repoRoot, roots: [] })).toThrow(/扫描根配置/);
    expect(() => scanHostChineseErrorLiterals({ repoRoot, roots: ['src/host/missing'] })).toThrow(/扫描根不存在/);
    expect(() => scan()).toThrow(/扫描 0 个源文件/);
  });

  it('扫描到文件但 0 个目标时 fail loud', () => {
    writeFileSync(join(scanRoot, 'no-target.ts'), `export const result = { message: '只有普通中文' };\n`);
    expect(() => scan()).toThrow(/命中 0 个中文 error 字面量/);
  });

  it('任一 TypeScript 文件解析失败时 fail loud', () => {
    writeFileSync(join(scanRoot, 'broken.ts'), `export const broken = { error: '解析失败'\n`);
    expect(() => scan()).toThrow(/TypeScript 解析失败/);
  });

  it('最新 origin/main 实测值不超棘轮基线', () => {
    const report = scanHostChineseErrorLiterals() as ScanReport;
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.targetCount).toBeGreaterThan(0);
    expect(report.targetCount).toBeLessThanOrEqual(BASELINE_MAX as number);
  });
});
