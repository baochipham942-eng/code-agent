import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { scanCopy, PRESSURE_BASELINE_MAX, ELLIPSIS_BASELINE_MAX } from '../../scripts/check-copy.mjs';

// 文案 lint 门（A2）——规则见 scripts/check-copy.mjs 头注。
// 违例样本全部用「拼接」构造后写进临时目录 fixture（maka #663 错题本：
// 规则文档/测试里的违例样本不得以字面量出现，别让闸匹配到自己）。
// fixture 放 os.tmpdir 而非仓库内：scanCopy 的排除名单含 /tests/，仓库内 fixture 扫不到。
const PRESSURE = '一' + '键';
const DOTS = '.' + '.' + '.';
const JARGON = '幂' + '等';
const BT = '`';

type ScanResult = {
  violations: { 'pressure-word': string[]; ellipsis: string[] };
  warnings: { jargon: string[] };
  fileCount: number;
};

describe('copy gate（check-copy.mjs）', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'copy-gate-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('红例：压力词 / 中文串三点 / 黑话逐条命中，行号准确', () => {
    const red = [
      `const a = '${PRESSURE}安装全部依赖';`,
      `const b = '加载中${DOTS}';`,
      `const c = '同步需要${JARGON}处理';`,
      `const t = ${BT}点这里${PRESSURE}导出`,
      `第二行加载中${DOTS}${BT};`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'red.ts'), red);
    const r = scanCopy(join(dir, 'red.ts')) as ScanResult;

    expect(r.violations['pressure-word']).toHaveLength(2);
    expect(r.violations['pressure-word'][0]).toContain(':1');
    expect(r.violations['pressure-word'][1]).toContain(':4');
    expect(r.violations.ellipsis).toHaveLength(2);
    expect(r.violations.ellipsis[0]).toContain(':2');
    expect(r.violations.ellipsis[1]).toContain(':5');
    expect(r.warnings.jargon).toHaveLength(1);
    expect(r.warnings.jargon[0]).toContain(':3');
  });

  it('绿例：注释先剥（maka #663 回归）/ copy-allow 豁免 / 英文串三点 / spread / regex 引号，全不误报', () => {
    const green = [
      `// ${PRESSURE}出现在行注释里，剥注释后不得命中`,
      `/* 块注释里写 加载中${DOTS} 也不得命中 */`,
      `const ok1 = '安装全部依赖';`,
      `const ok2 = '加载中…';`,
      `const ok3 = 'loading${DOTS}';`,
      `const arr = [${DOTS}ok1];`,
      `const re = /['"]配置/;`,
      `const exempted = '${PRESSURE}体验'; // copy-allow: 测试豁免通道`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'green.ts'), green);
    const r = scanCopy(join(dir, 'green.ts')) as ScanResult;

    expect(r.violations['pressure-word']).toHaveLength(0);
    expect(r.violations.ellipsis).toHaveLength(0);
    expect(r.warnings.jargon).toHaveLength(0);
  });

  it('扫描面为空时 fail loud（门空转自检）', () => {
    expect(() => scanCopy(join(dir, 'no-such-dir'))).toThrow(/自检失败/);
  });

  it('仓库现状不超棘轮基线（收口后请调小脚本里的基线）', () => {
    const r = scanCopy() as ScanResult;
    expect(r.violations['pressure-word'].length).toBeLessThanOrEqual(PRESSURE_BASELINE_MAX as number);
    expect(r.violations.ellipsis.length).toBeLessThanOrEqual(ELLIPSIS_BASELINE_MAX as number);
  });
});
