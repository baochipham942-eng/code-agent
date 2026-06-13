// ============================================================================
// check-capability-evidence 门的纯逻辑测试
// ----------------------------------------------------------------------------
// 钉住三类"完成未兑现"失败模式的检出，以及真实 manifest 不退化。
// ============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  evaluateCapabilityEvidence,
  CAPABILITIES,
  type CapabilityEvidence,
  type FileProbe,
} from '../../scripts/check-capability-evidence';

// 构造一个"全部齐备"的探针：任意路径都返回达标文件
function probeFrom(files: Record<string, { lineCount: number; content: string }>): FileProbe {
  return (relPath) => files[relPath] ?? null;
}

const SAMPLE: CapabilityEvidence[] = [
  {
    name: 'demo',
    deliverables: [{ path: 'src/demo.ts', minLines: 100, markers: ['realImpl('] }],
    evidence: ['tests/demo.test.ts'],
  },
];

const HEALTHY = probeFrom({
  'src/demo.ts': { lineCount: 150, content: 'function realImpl() {}' },
  'tests/demo.test.ts': { lineCount: 10, content: 'it()' },
});

describe('evaluateCapabilityEvidence', () => {
  it('全部齐备时返回空失败列表', () => {
    expect(evaluateCapabilityEvidence(SAMPLE, HEALTHY)).toEqual([]);
  });

  it('检出零交付（交付物文件缺失）', () => {
    const probe = probeFrom({ 'tests/demo.test.ts': { lineCount: 10, content: 'it()' } });
    const failures = evaluateCapabilityEvidence(SAMPLE, probe);
    expect(failures.some((f) => f.includes('零交付'))).toBe(true);
  });

  it('检出 stub（交付物行数低于阈值）', () => {
    const probe = probeFrom({
      'src/demo.ts': { lineCount: 12, content: 'function realImpl() {}' },
      'tests/demo.test.ts': { lineCount: 10, content: 'it()' },
    });
    const failures = evaluateCapabilityEvidence(SAMPLE, probe);
    expect(failures.some((f) => f.includes('stub'))).toBe(true);
  });

  it('检出模板冒充（交付物缺少真实现标记）', () => {
    const probe = probeFrom({
      'src/demo.ts': { lineCount: 150, content: '// 全是模板占位 (none)' },
      'tests/demo.test.ts': { lineCount: 10, content: 'it()' },
    });
    const failures = evaluateCapabilityEvidence(SAMPLE, probe);
    expect(failures.some((f) => f.includes('模板冒充'))).toBe(true);
  });

  it('检出无运行证据（证据入口缺失）', () => {
    const probe = probeFrom({
      'src/demo.ts': { lineCount: 150, content: 'function realImpl() {}' },
    });
    const failures = evaluateCapabilityEvidence(SAMPLE, probe);
    expect(failures.some((f) => f.includes('无运行证据'))).toBe(true);
  });

  it('多个失败可同时累积，不短路', () => {
    const probe = probeFrom({}); // 全缺
    const failures = evaluateCapabilityEvidence(SAMPLE, probe);
    // 交付物缺失 + 证据缺失，至少 2 条
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });
});

describe('真实 manifest 不退化（与仓库实际文件对账）', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const realProbe: FileProbe = (relPath) => {
    const abs = path.join(repoRoot, relPath);
    if (!fs.existsSync(abs)) return null;
    const content = fs.readFileSync(abs, 'utf8');
    return { lineCount: content.split('\n').length, content };
  };

  it('CAPABILITIES 中四个能力的交付物/标记/运行证据当前均齐备', () => {
    expect(evaluateCapabilityEvidence(CAPABILITIES, realProbe)).toEqual([]);
  });

  it('登记了审计点名的四个能力', () => {
    expect(CAPABILITIES.map((c) => c.name).sort()).toEqual(
      ['checkpoint-writer', 'distill', 'dream', 'max-mode'],
    );
  });
});
