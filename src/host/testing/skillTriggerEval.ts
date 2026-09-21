/**
 * skill 触发判定（N-SKILL-TRIGGER-EVAL）
 *
 * 判据 = skill_activated 事件计数：Skill 工具真实执行成功才 emit
 * （fork 模式子代理跑成功 skill.ts / inline 模式指令注入成功）。
 * 「装进上下文」（discovery 白名单、Skill 工具描述里列出名单）不算触发；
 * 「Skill 工具被调用」也不算——名不存在 / 被禁用 / 越权时调用失败，不 emit。
 *
 * 两个判定读 adapter 按题交出的 CaseSkillSignals：
 *   skill_triggered      —— params: skills（必填非空字符串数组，精确名）、mode（'any' 默认 / 'all'）。
 *                           隐式触发题用：题面不点名 skill，但它该被真调起来。
 *   skill_not_triggered  —— params: skills（同上）。负样本题用：名单内一次都不许触发。
 *
 * fail-loud 三层口径（与 approvalRequestEval / memoryEval 同原则）：
 *   1. 非法参数（skills 缺失/空/非字符串、mode 非法）显式红；
 *   2. 没有证据源（mock / 旧 adapter，skillContext 缺席）显式红——「没记录」和
 *      「记录了零次」是两回事，混起来负样本全部假绿；
 *   3. 声明的 skill 不在本题 skillContext 显式红——负样本里它证不了「忍住了」
 *      （根本没装进上下文），正向里它永不可能触发；两者都是配置错，不是能力数据。
 */
import type { CaseSkillSignals } from './types';

export interface SkillTriggerEvaluation {
  passed: boolean;
  actual: unknown;
  expected: string;
  details: string;
}

/**
 * 断言侧的证据切面：两字段都是可选，但 skillContext 缺席 = adapter 没接记录器
 * （mock / 旧 adapter），fail-loud——「没记录」和「记录了零次」必须分开。
 */
export type SkillTriggerEvidence = Partial<CaseSkillSignals> | undefined;

function parseSkillNames(params: Record<string, unknown>): string[] | string {
  const value = params.skills;
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || (item as string).trim().length === 0)) {
    return 'skills must be a non-empty string array (exact skill names)';
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function invalid(type: string, reason: string): SkillTriggerEvaluation {
  return { passed: false, actual: `invalid params: ${reason}`, expected: `valid ${type} params`, details: reason };
}

export function evaluateSkillTriggerExpectation(
  type: 'skill_triggered' | 'skill_not_triggered',
  params: Record<string, unknown>,
  evidence: SkillTriggerEvidence,
): SkillTriggerEvaluation {
  const names = parseSkillNames(params);
  if (typeof names === 'string') return invalid(type, names);
  const wantTrigger = type === 'skill_triggered';
  const rawMode = params.mode ?? 'any';
  if (wantTrigger && rawMode !== 'any' && rawMode !== 'all') {
    return invalid(type, "mode must be 'any' or 'all'");
  }
  if (!wantTrigger && params.mode !== undefined) {
    return invalid(type, 'mode is only supported by skill_triggered');
  }

  const expected = wantTrigger
    ? rawMode === 'all'
      ? 'every declared skill actually activated'
      : 'at least one declared skill actually activated'
    : 'none of the declared skills activated';

  if (evidence?.skillContext === undefined) {
    return {
      passed: false,
      actual: 'no skill trigger trace available',
      expected,
      details: 'adapter 没有接 skill 触发记录器，判定没有证据源（mock 或旧 adapter）',
    };
  }

  const activations = evidence.skillActivations ?? {};
  const contextNames = new Set(evidence.skillContext);
  const notInContext = names.filter((name) => !contextNames.has(name));
  if (notInContext.length > 0) {
    return {
      passed: false,
      actual: `skills not in this case's context: ${notInContext.join(', ')}`,
      expected,
      details: wantTrigger
        ? `${notInContext.join('、')} 没装进本题上下文（本题可见：${evidence.skillContext.join('、') || '空'}），永不可能触发——这是配置错（漏配 --skills / 名写错），不是能力数据`
        : `${notInContext.join('、')} 没装进本题上下文（本题可见：${evidence.skillContext.join('、') || '空'}），负样本证不了「该触发时忍住了」——这是配置错（漏配 --skills / 名写错），不是能力数据`,
    };
  }

  const triggered = names.filter((name) => (activations[name] ?? 0) > 0);
  const passed = wantTrigger
    ? (rawMode === 'all' ? triggered.length === names.length : triggered.length > 0)
    : triggered.length === 0;

  return {
    passed,
    actual: triggered.length === 0 ? 'no declared skill activated' : triggered.map((name) => `${name}×${activations[name]}`),
    expected,
    details: `本题 skill 触发落账 ${Object.keys(activations).length} 种；`
      + `${names.length} 条判据命中 ${triggered.length} 条（${wantTrigger ? `mode=${rawMode}` : '负向'}）`,
  };
}
