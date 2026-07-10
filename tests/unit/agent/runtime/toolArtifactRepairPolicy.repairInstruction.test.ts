// ============================================================================
// B7 P1 修复指令密度分档单测 — buildArtifactRepairInstruction full/compact
//
// 身份块的 snapshot 基线是从 P1 改动前的实现（main 1db5986c7 的
// toolArtifactRepairPolicy.ts）真跑生成的：先 checkout 基版文件 → vitest -u
// 生成 snapshot → 恢复 P1 实现后必须原样全绿 = flag 关闭输出逐字节不变。
// 重新 -u 会用新代码覆盖基线，等于放弃身份保证——除非有意变更 full 版文案。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildArtifactRepairInstruction } from '../../../../src/host/agent/runtime/toolArtifactRepairPolicy';
import type { ArtifactRepairPhase } from '../../../../src/host/agent/runtime/toolArtifactRepairPolicy';
import type { ArtifactRepairIssueCode } from '../../../../src/host/agent/runtime/artifactRepairSpec';
import type { BrowserVisualSmokeSummary } from '../../../../src/host/agent/runtime/browser/types';

const ABS_PATH = '/tmp/fixture/game/index.html';
const FAILURES = [
  'contract: __GAME_TEST__.start() missing',
  'metric: playable fps below threshold',
  'coverage: score change never observed after real input',
];
const SPEC_BLOCK = [
  '<artifact_repair_spec>',
  '{"issues":[{"code":"missing_gameplay_mechanics"}]}',
  '</artifact_repair_spec>',
].join('\n');
const SMOKE: BrowserVisualSmokeSummary = {
  attempted: true,
  passed: false,
  checks: ['canvas rendered non-blank'],
  failures: ['first keypress threw ReferenceError'],
};
const PLATFORMER_CODES: readonly ArtifactRepairIssueCode[] = ['missing_gameplay_mechanics'];

function build(
  phase: ArtifactRepairPhase,
  attempts: number,
  opts: {
    smoke?: BrowserVisualSmokeSummary;
    codes?: readonly ArtifactRepairIssueCode[];
    style?: 'full' | 'compact';
  } = {},
): string {
  if (opts.style) {
    return buildArtifactRepairInstruction(
      ABS_PATH, FAILURES, attempts, phase, SPEC_BLOCK, opts.smoke, opts.codes ?? [], opts.style,
    );
  }
  // 不传 style = 生产 flag 关闭时的调用形状（默认参数路径）
  return buildArtifactRepairInstruction(
    ABS_PATH, FAILURES, attempts, phase, SPEC_BLOCK, opts.smoke, opts.codes ?? [],
  );
}

// —— 身份保证：不传 style（= flag 关闭时唯一路径）输出与 P1 改动前逐字节一致 ——
describe('身份保证：默认 style 输出与改动前 byte-identical（基线 snapshot 取自 main 1db5986c7）', () => {
  const matrix: Array<[string, ArtifactRepairPhase, number, { smoke?: BrowserVisualSmokeSummary; codes?: readonly ArtifactRepairIssueCode[] }]> = [
    ['首轮 baseline_repair attempts=1', 'baseline_repair', 1, {}],
    ['targeted_repair attempts=2 + browser evidence', 'targeted_repair', 2, { smoke: SMOKE }],
    ['targeted_repair attempts=2 + platformer 结构失败码', 'targeted_repair', 2, { codes: PLATFORMER_CODES }],
    ['read_then_patch attempts=3（"不要重写整页"分支）', 'read_then_patch', 3, {}],
    ['read_then_patch attempts=4 + platformer + evidence', 'read_then_patch', 4, { smoke: SMOKE, codes: PLATFORMER_CODES }],
    ['fresh_rewrite attempts=5（干净重写优先分支）', 'fresh_rewrite', 5, { smoke: SMOKE }],
  ];

  it.each(matrix)('%s', (_name, phase, attempts, opts) => {
    expect(build(phase, attempts, opts)).toMatchSnapshot();
  });

  it("显式 style='full' 与默认参数输出完全一致", () => {
    expect(build('read_then_patch', 3, { style: 'full' })).toBe(build('read_then_patch', 3));
    expect(build('fresh_rewrite', 5, { smoke: SMOKE, style: 'full' })).toBe(
      build('fresh_rewrite', 5, { smoke: SMOKE }),
    );
  });
});

// —— compact 行为契约 ——
describe("compact style（B7 strong 档）", () => {
  it('compact 含失败项清单 + 一行修复指令，删掉长说教且不再内联 repairSpecBlock', () => {
    const compact = build('read_then_patch', 3, { smoke: SMOKE, style: 'compact' });
    // 保留：结构化头 + 全部失败项 + 浏览器证据 + 一行指令
    expect(compact).toContain('<artifact-validation-failed kind="interactive_artifact">');
    expect(compact).toContain('attempts: 3');
    expect(compact).toContain('repair phase: read_then_patch');
    expect(compact).toContain(`target file: ${ABS_PATH}`);
    for (const failure of FAILURES) expect(compact).toContain(failure);
    expect(compact).toContain('first keypress threw ReferenceError');
    expect(compact).toContain('直接对目标文件做最小修复');
    // 删掉：full 版 attempts>=3 的长说教与内联 spec（spec 仍随 toolResult.error 返回）
    expect(compact).not.toContain('<artifact_repair_spec>');
    expect(compact).not.toContain('不要把 __GAME_TEST__');
    expect(compact).not.toContain('coverage 只能');
    expect(compact.length).toBeLessThan(build('read_then_patch', 3, { smoke: SMOKE }).length);
  });

  it('fresh_rewrite 优先分支在 compact 下保留：attempts>=3 + fresh_rewrite 出重写指令，无"最小修复/不要重写"矛盾话术', () => {
    const compact = build('fresh_rewrite', 5, { smoke: SMOKE, style: 'compact' });
    expect(compact).toContain('干净重写');
    expect(compact).toContain('Write 输出全新实现');
    // 与补丁阶梯相反的措辞不得混入（既有坑：重写轮出现"不要重写整页"自相矛盾）
    expect(compact).not.toContain('最小修复');
    expect(compact).not.toContain('不要重写整页');
    for (const failure of FAILURES) expect(compact).toContain(failure);
  });

  it('compact 非重写轮不受 attempts 影响话术分裂（1/2/3 次同一模板，仅 attempts 行不同）', () => {
    const a1 = build('baseline_repair', 1, { style: 'compact' });
    const a3 = build('baseline_repair', 3, { style: 'compact' });
    expect(a1.replace('attempts: 1', 'attempts: 3')).toBe(a3);
  });
});
