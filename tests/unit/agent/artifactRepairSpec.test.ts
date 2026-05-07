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
      '发现 progress/coverage 说明，但缺少 reachability/acceptance/progressPlan/validation 元数据；__GAME_META__.progress 或 coverage 对象不算可执行验收计划。请添加 progressPlan 或 reachability 数组，每一步包含 input、frames、metric 和 expect。',
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
    expect(spec.issues[3].repairInstruction).toContain('progressPlan');
    expect(spec.issues[3].repairInstruction).toContain('do not rename it progress');
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

    const formatted = formatArtifactRepairSpecForPrompt(spec);
    expect(formatted).toContain('Reachability repair template');
    expect(formatted).toContain('Do not assert score/progress/win/gate/ability changes');
    expect(formatted).toContain('real dispatchable controls');
  });

  it('classifies shortcut gameplay mutation and fake runtime evidence', () => {
    const spec = createArtifactRepairSpec(summary([
      '测试合约 step() 直接用宽松距离或测试模式修改奖励、收集物或能力状态；这会让奖励/能力不可达时也显示通过。请让 step() 只推进真实输入、碰撞和物理结果。',
      'runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。请用前后 snapshot 的真实状态变化证明承诺的交互。',
      'runSmokeTest 直接修改进度、分数、关卡、胜利或解锁状态后再声明通过；这不能证明玩家能用真实输入完成该链路。请通过 start/reset/step/snapshot 驱动真实玩法，并用 before/after snapshot 证明变化。',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual([
      'shortcut_state_mutation',
      'coverage_without_runtime_evidence',
    ]);
    expect(spec.issues[1].evidence).toHaveLength(2);
    expect(spec.issues[1].repairInstruction).toContain('before/after snapshot');
    expect(spec.issues[1].repairInstruction).toContain('merely exist');

    const formatted = formatArtifactRepairSpecForPrompt(spec);
    expect(formatted).toContain('enemy_present');
    expect(formatted).toContain('Only add coverage after checks');
  });

  it('classifies non-responsive canvas layout failures', () => {
    const spec = createArtifactRepairSpec(summary([
      '大型固定 canvas (800x480) 缺少响应式 CSS；窄窗口会裁切游戏画面。请保留内部分辨率，但给 canvas 或 wrapper 加 max-width/max-height/aspect-ratio/height:auto 等缩放约束。',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual(['canvas_not_responsive']);
    expect(spec.issues[0].repairInstruction).toContain('max-width');

    const formatted = formatArtifactRepairSpecForPrompt(spec);
    expect(formatted).toContain('Canvas layout is not responsive');
    expect(formatted).toContain('responsive');
  });

  it('classifies frontend browser validation failures with render repair hints', () => {
    const spec = createArtifactRepairSpec(summary([
      'browser visual smoke saw console errors: Uncaught TypeError: Cannot read properties of undefined',
      'desktop visual smoke sampled canvas pixels but found no nonblank rendered content.',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual(['frontend_visual_smoke_failed']);
    expect(spec.issues[0].repairInstruction).toContain('rendered frontend');

    const formatted = formatArtifactRepairSpecForPrompt(spec);
    expect(formatted).toContain('Frontend browser validation failed');
    expect(formatted).toContain('Fix actual page load/render problems');
  });

  it('classifies platformer gameplay mechanics contract failures with executable hints', () => {
    const spec = createArtifactRepairSpec(summary([
      'platformer 缺少 gameplayMechanics 元数据；请在 __GAME_META__ 中声明并实现 enemies、blocks、abilities、gates、comboChallenge。',
      'platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。',
      'platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。',
      'Failed to bump block or gain ability',
      'Failed to stomp enemy',
      'Gate remained locked after enemy death',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual([
      'missing_gameplay_mechanics',
      'gameplay_mechanics_without_runtime_evidence',
      'ability_gate_without_reachability',
    ]);
    expect(spec.issues[0].repairInstruction).toContain('enemies, blocks, abilities, gates, and comboChallenge');
    expect(spec.issues[1].repairInstruction).toContain('before/after snapshot');
    expect(spec.issues[2].repairInstruction).toContain('false->true');

    const formatted = formatArtifactRepairSpecForPrompt(spec);
    expect(formatted).toContain('__GAME_META__.gameplayMechanics');
    expect(formatted).toContain('never an object map');
    expect(formatted).toContain('stomp enemy');
    expect(formatted).toContain('reachableTarget');
    expect(formatted).toContain('Failed to bump block');
  });

  it('classifies numeric coverage counts as smoke coverage repair', () => {
    const spec = createArtifactRepairSpec(summary([
      'runSmokeTest coverage.mechanics 必须列出已验证的机制名称或布尔证据对象，不能只返回数字、布尔值或 total 计数。',
      'runSmokeTest coverage.stateChanges 必须列出已验证的机制名称或布尔证据对象，不能只返回数字、布尔值或 total 计数。',
    ]));

    expect(spec.issues.map((issue) => issue.code)).toEqual(['smoke_missing_coverage']);
    expect(spec.issues[0].evidence).toHaveLength(2);
    expect(spec.issues[0].repairInstruction).toContain('mechanics');
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

    expect(inferArtifactRepairIssueCodesFromText('canvas_not_responsive')).toEqual([
      'canvas_not_responsive',
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
