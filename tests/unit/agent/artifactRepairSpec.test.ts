import { describe, expect, it } from 'vitest';
import type { GameArtifactValidationSummary } from '../../../src/main/agent/runtime/gameArtifactValidator';
import {
  createArtifactRepairSpec,
  formatArtifactRepairSpecForPrompt,
  inferArtifactRepairIssueCodesFromText,
} from '../../../src/main/agent/runtime/artifactRepairSpec';

function summary(failures: string[]): GameArtifactValidationSummary {
  return {
    shouldValidate: true,
    inferredKind: 'game',
    isComplete: false,
    passed: false,
    failures,
    checks: [],
  };
}

describe('artifactRepairSpec', () => {
  it('classifies static validator failures into structured repair issues', () => {
    const spec = createArtifactRepairSpec(summary([
      'HTML 文件还没有完整闭合，先继续补齐内容再做游戏验收。',
      'HTML 在 </html> 之后还有非空内容；浏览器会忽略这部分脚本或数据，说明分块追加位置错误。',
      '缺少 controls 元数据；工程层不知道该模拟什么输入来验证真实可操作性。',
      '缺少 reachability/acceptance/progressPlan 元数据；工程层无法验证目标、场景或关卡能被推进。',
      '交互测试合约缺少 start()，验收无法从真实初始状态启动产物。',
      '交互测试合约缺少 snapshot()，验收无法读取主对象、进度或反馈变化。',
      '交互测试合约缺少 runSmokeTest()，验收无法用真实输入证明游戏可操作。',
    ]));

    expect(spec.kind).toBe('game_artifact_repair');
    expect(spec.issues.map((issue) => issue.code)).toEqual([
      'html_incomplete',
      'trailing_after_html',
      'missing_controls_metadata',
      'missing_reachability_metadata',
      'missing_contract_start',
      'missing_contract_snapshot',
      'missing_contract_smoke',
    ]);
    expect(spec.mustFix).toHaveLength(7);
    expect(spec.allowedEditScope.join(' ')).toContain('generated artifact file');
    expect(spec.nextAction).toContain('validation again');
  });

  it('classifies runtime smoke failures and merges duplicate issue codes', () => {
    const spec = createArtifactRepairSpec(summary([
      '声明的输入执行后 snapshot 没有变化，无法证明主对象可操作。',
      'reachability step 1 没有让 progress 满足 increase。',
      'reachability step 2 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。',
      'reachability step 3 的 metric "powerUp" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。',
      'coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=3, passed=1, total=1。',
      'runSmokeTest 缺少 coverage，无法证明玩法、奖励/风险或关卡覆盖。',
      'runSmokeTest 未通过。',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual([
      'control_no_state_change',
      'non_executable_reachability_input',
      'missing_snapshot_metric',
      'level_coverage_incomplete',
      'smoke_missing_coverage',
      'run_smoke_failed',
    ]);
    expect(spec.issues[0].evidence).toHaveLength(2);
    expect(spec.issues.every((issue) => issue.repairInstruction.length > 20)).toBe(true);
  });

  it('classifies shortcut gameplay mutation and fake runtime evidence', () => {
    const spec = createArtifactRepairSpec(summary([
      '测试合约 step() 直接用宽松距离或测试模式修改奖励、收集物或能力状态；这会让奖励/能力不可达时也显示通过。请让 step() 只推进真实输入、碰撞和物理结果。',
      'runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。请用前后 snapshot 的真实状态变化证明承诺的交互。',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual([
      'shortcut_state_mutation',
      'coverage_without_runtime_evidence',
    ]);
    expect(spec.issues[1].repairInstruction).toContain('before/after snapshot');
    expect(spec.issues[1].repairInstruction).toContain('merely exist');

    const formatted = formatArtifactRepairSpecForPrompt(spec);
    expect(formatted).toContain('enemy_present');
    expect(formatted).toContain('Only add coverage after checks');
  });

  it('infers active repair issue codes from validator context text', () => {
    expect(inferArtifactRepairIssueCodesFromText([
      '修复目标：',
      '- 修复 window.__GAME_TEST__ / window.__INTERACTIVE_TEST__ 交互测试合约，使 start/reset/step/snapshot/runSmokeTest 与真实游戏状态一致。',
      '',
      '当前 validator 失败摘要：',
      'runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。',
    ].join('\n'))).toContain('coverage_without_runtime_evidence');

    expect(inferArtifactRepairIssueCodesFromText([
      '修复目标：',
      '- 修复 window.__GAME_TEST__ / window.__INTERACTIVE_TEST__ 交互测试合约，使 start/reset/step/snapshot/runSmokeTest 与真实游戏状态一致。',
      '当前 validator 失败摘要：',
      'runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。',
    ].join('\n'))).not.toContain('missing_test_contract');

    expect(inferArtifactRepairIssueCodesFromText('repair 1 issue: coverage_without_runtime_evidence')).toEqual([
      'coverage_without_runtime_evidence',
    ]);
  });

  it('falls back to generic_validation_failure for unknown text', () => {
    const spec = createArtifactRepairSpec(summary(['一个新的 validator 失败文本。']));

    expect(spec.issues).toHaveLength(1);
    expect(spec.issues[0]).toMatchObject({
      code: 'generic_validation_failure',
      severity: 'warning',
    });
  });

  it('formats a short bounded prompt block', () => {
    const spec = createArtifactRepairSpec(summary([
      '缺少通用交互测试合约 window.__INTERACTIVE_TEST__ 或 window.__GAME_TEST__，工程层无法真实启动、输入并读取状态变化。',
      ...Array.from({ length: 20 }, (_, index) => `未知失败 ${index} ${'x'.repeat(300)}`),
    ]));

    const formatted = formatArtifactRepairSpecForPrompt(spec);

    expect(formatted.startsWith('<artifact_repair_spec>')).toBe(true);
    expect(formatted.endsWith('</artifact_repair_spec>')).toBe(true);
    expect(formatted.length).toBeLessThanOrEqual(3800);
    expect(formatted).toContain('"missing_test_contract"');
  });
});
