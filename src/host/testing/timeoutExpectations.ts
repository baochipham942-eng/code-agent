// ============================================================================
// N-EVAL-TIMEOUT-K2-NEGASSERT：超时题在刀1 保全的轨迹上补跑负向过程断言
// ============================================================================
// 只跑被掐时结论已定的类型（expectationCatalog 的 TIMEOUT_VERDICT_KIND）。
// status / failureStage / score 不动，失败项按正常路径的 `[<type>] <details>` 拼进
// failureReason，码本才能命中（compliance_risk 压过 timeout，其余只进 symptoms）。
// ============================================================================
import { runExpectations } from './assertionEngine';
import { isTimeoutJudgeable } from './expectationCatalog';
import type { CaseSkillSignals, Expectation, ExpectationResult, TestResult } from './types';

export function formatExpectationFailures(results: ExpectationResult[]): string {
  return results.filter((r) => !r.passed).map((r) => `[${r.expectation.type}] ${r.evidence.details ?? 'failed'}`).join('; ');
}

/** 证据源 / 锚点在被掐时还不存在：正常路径会 fail-loud，超时题窗口还没关，记未判。 */
function hasEvidence(expectation: Expectation, result: TestResult): boolean {
  if (expectation.type === 'approval_not_requested') return result.permissionRequests !== undefined;
  // N-SKILL-TRIGGER-EVAL：触发落账没被交出来（adapter 没接记录器）就不判——
  // 「没记录」和「零触发」混起来负样本会假绿。
  if (expectation.type === 'skill_not_triggered') return result.skillContext !== undefined;
  if (expectation.type === 'sim_stop_respected' || expectation.type === 'sim_no_write_before_rule') {
    const isAfter = expectation.type === 'sim_stop_respected';
    const ruleId = expectation.params[isAfter ? 'after_rule' : 'before_rule'];
    // 锚点口径与 assertionEngine 对齐：该规则第一次命中的那条记录（find-first）。
    const anchor = result.simTurns?.find((turn) => turn.ruleId === ruleId);
    if (!anchor) return false;
    // sim_stop_respected 的窗口在锚点之后：拒绝没真送到 agent 手里，「拒绝后没继续写」
    // 就是零证据判绿（K2 PR#1878 ai-review Nit 1 / 审计 R1-H2 的形状）。
    // sim_no_write_before_rule 的窗口在锚点之前，那些调用已经发生完了，与送没送达无关，照判。
    return isAfter ? anchor.delivered === true : true;
  }
  return true;
}

export async function judgeTimeoutExpectations(
  expectations: Expectation[] | undefined,
  result: TestResult,
  workingDirectory: string,
  consumeSkillSignals?: () => Promise<CaseSkillSignals | undefined>,
): Promise<void> {
  const candidates = (expectations ?? []).filter((expectation) => isTimeoutJudgeable(expectation.type));
  if (candidates.length === 0) return;
  // N-SKILL-TRIGGER-EVAL：skill_activated 落账在 adapter 侧按 testId 累积，不受掐断影响——
  // 补判前交出，skill_not_triggered 才有证据源；交不出（thunk 缺席/返空）则进 unjudged。
  // 只有候选里真有 skill 断言才调 thunk：无关题的补判不该为技能发现初始化付出炸点
  // （ai-review PR#2019 R2）。
  if (candidates.some((expectation) => expectation.type === 'skill_not_triggered')) {
    Object.assign(result, (await consumeSkillSignals?.()) ?? {});
  }
  const judged = candidates.filter((expectation) => hasEvidence(expectation, result));
  const { results } = await runExpectations(judged, {
    toolExecutions: result.toolExecutions,
    responses: result.responses,
    errors: result.errors,
    turnCount: result.turnCount,
    workingDirectory,
    simTurns: result.simTurns,
    permissionRequests: result.permissionRequests,
    skillActivations: result.skillActivations,
    skillContext: result.skillContext,
  });
  result.expectationResults = results;
  result.timeoutExpectations = {
    judged: judged.map((expectation) => expectation.type),
    unjudged: candidates.filter((expectation) => !judged.includes(expectation)).map((expectation) => expectation.type),
  };
  const failures = formatExpectationFailures(results);
  if (failures) result.failureReason = result.failureReason ? `${result.failureReason}; ${failures}` : failures;
}
