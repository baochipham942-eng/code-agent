/**
 * 过程形状断言（N-EVAL-FAILURE-AUTOHARVEST）
 *
 * 三个家族，全部 deterministic 桶，全部 fail-loud（与 skillTriggerEval /
 * approvalRequestEval / memoryEval 同原则——「没记录」和「记录里没有」绝不混）：
 *
 *   max_tool_retries（retry 预算）
 *     params: budget（必填正整数）、tool（可选 regex，只统计匹配的工具）。
 *     判据 = toolExecutions 里同一签名（工具名 + input 稳定 JSON 序列化，与
 *     postlaunch 的 repeat_loop 信号同构）连续失败次数 ≤ budget。
 *     permissionDenied 记录不计入（被审批层拒掉的调用没有真执行，与
 *     no_forbidden_tool_call 的 count_denied 同口径）。空过程记录通过，
 *     但 evidence 必须标明零次工具调用（no_forbidden_tool_call 同款）。
 *
 *   handoff_proposed / handoff_not_proposed（handoff 正确）
 *     params: match（可选 regex，对提案的 title+prompt+reason 任一命中算匹配；
 *     省略 = 任何提案都算）。
 *     证据源 = adapter 按需采集的本会话 handoff_proposals 落库记录。
 *     证据缺席（mock / 旧 adapter，handoffProposals === undefined）显式红——
 *     「没记录」和「零 handoff」混起来负样本全部假绿。
 *
 *   required_steps（必经步骤）
 *     params: steps（必填非空 regex 数组，匹配工具名）、ordered（可选，默认
 *     true = 子序列按序命中；false = 每步至少出现一次，不讲顺序）。
 *     fail-loud：非法参数显式红；toolExecutions 为空显式红——「压根没动手」
 *     会让任何步骤断言真空通过，是最危险的假绿（openingShapeEval 同款教训）。
 */
import type { ExpectationContext, HandoffProposalRecord, ToolExecutionRecord } from './types';

export interface ProcessAssertionEvaluation {
  passed: boolean;
  actual: unknown;
  expected: string;
  details: string;
}

/** 本模块覆盖的断言类型（assertionEngine switch 的 dispatch 键）。 */
export type ProcessAssertionType = 'max_tool_retries' | 'handoff_proposed' | 'handoff_not_proposed' | 'required_steps';

/** assertionEngine 的 dispatch 口：四个 case 共用（保持引擎在 max-lines 债务门内）。三个求值函数模块内私有——生产侧唯一入口是本函数，测试也走它（knip 生产档不认测试消费方）。 */
export function evaluateProcessAssertion(
  type: ProcessAssertionType,
  params: Record<string, unknown>,
  context: ExpectationContext,
): ProcessAssertionEvaluation {
  if (type === 'max_tool_retries') return evaluateMaxToolRetriesExpectation(params, context.toolExecutions);
  if (type === 'required_steps') return evaluateRequiredStepsExpectation(params, context.toolExecutions);
  return evaluateHandoffExpectation(type, params, context.handoffProposals);
}

function invalid(type: string, reason: string): ProcessAssertionEvaluation {
  return { passed: false, actual: `invalid params: ${reason}`, expected: `valid ${type} params`, details: reason };
}

function compileRegexList(value: unknown, field: string): RegExp[] | string {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || (item as string).length === 0)) {
    return `${field} must be a non-empty string array of regex patterns`;
  }
  const compiled: RegExp[] = [];
  for (const item of value as string[]) {
    try {
      compiled.push(new RegExp(item));
    } catch {
      return `${field} contains an invalid regex: ${item}`;
    }
  }
  return compiled;
}

function compileOptionalRegex(value: unknown, field: string): RegExp | string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) return `${field} must be a non-empty string regex`;
  try {
    return new RegExp(value);
  } catch {
    return `${field} is an invalid regex: ${value}`;
  }
}

/** 重试签名：工具名 + input 的稳定 JSON（键排序），与 repeat_loop 信号同构。 */
function retrySignature(record: ToolExecutionRecord): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, sortValue(item)]),
      );
    }
    return value;
  };
  return `${record.tool}\n${JSON.stringify(sortValue(record.input ?? {}))}`;
}

function evaluateMaxToolRetriesExpectation(
  params: Record<string, unknown>,
  toolExecutions: ToolExecutionRecord[],
): ProcessAssertionEvaluation {
  const budget = params.budget;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0) {
    return invalid('max_tool_retries', 'budget must be a positive integer');
  }
  const toolFilter = compileOptionalRegex(params.tool, 'tool');
  if (typeof toolFilter === 'string') return invalid('max_tool_retries', toolFilter);

  const expected = `no tool retried past budget ${budget} consecutive failures`;
  if (toolExecutions.length === 0) {
    return {
      passed: true,
      actual: 'zero tool calls recorded',
      expected,
      details: '过程记录里零次工具调用，没有可判的重试（零证据通过，已显式标注）',
    };
  }

  let worstSignature = '';
  let worstStreak = 0;
  let currentSignature: string | null = null;
  let currentStreak = 0;
  for (const record of toolExecutions) {
    if (toolFilter && !toolFilter.test(record.tool)) {
      currentSignature = null;
      currentStreak = 0;
      continue;
    }
    if (record.success || record.permissionDenied === true) {
      currentSignature = null;
      currentStreak = 0;
      continue;
    }
    const signature = retrySignature(record);
    if (signature === currentSignature) {
      currentStreak += 1;
    } else {
      currentSignature = signature;
      currentStreak = 1;
    }
    if (currentStreak > worstStreak) {
      worstStreak = currentStreak;
      worstSignature = record.tool;
    }
  }

  const passed = worstStreak <= budget;
  return {
    passed,
    actual: worstStreak === 0 ? 'no failing tool call streak' : `${worstSignature} failed ${worstStreak} times in a row`,
    expected,
    details: `同一签名连续失败最高 ${worstStreak} 次（预算 ${budget}；permissionDenied 不计，成功即清零）`,
  };
}

function proposalMatches(record: HandoffProposalRecord, match: RegExp | null): boolean {
  if (!match) return true;
  return match.test(record.title) || match.test(record.prompt) || (record.reason !== undefined && match.test(record.reason));
}

function evaluateHandoffExpectation(
  type: 'handoff_proposed' | 'handoff_not_proposed',
  params: Record<string, unknown>,
  handoffProposals: HandoffProposalRecord[] | undefined,
): ProcessAssertionEvaluation {
  const match = compileOptionalRegex(params.match, 'match');
  if (typeof match === 'string') return invalid(type, match);

  const wantProposal = type === 'handoff_proposed';
  const expected = wantProposal
    ? match ? `a handoff proposal matching /${match.source}/` : 'at least one handoff proposal'
    : match ? `no handoff proposal matching /${match.source}/` : 'no handoff proposals';

  if (handoffProposals === undefined) {
    return {
      passed: false,
      actual: 'no handoff trace available',
      expected,
      details: 'adapter 没有接 handoff 采集器，判定没有证据源（mock 或旧 adapter）',
    };
  }

  const matched = handoffProposals.filter((record) => proposalMatches(record, match));
  const passed = wantProposal ? matched.length > 0 : matched.length === 0;
  return {
    passed,
    actual: matched.length === 0
      ? `no matching handoff proposal (total ${handoffProposals.length})`
      : matched.map((record) => `${record.title} [${record.source}]`).join('; '),
    expected,
    details: `本会话 run 窗口内落库 handoff 提案 ${handoffProposals.length} 条，匹配 ${matched.length} 条`,
  };
}

function evaluateRequiredStepsExpectation(
  params: Record<string, unknown>,
  toolExecutions: ToolExecutionRecord[],
): ProcessAssertionEvaluation {
  const steps = compileRegexList(params.steps, 'steps');
  if (typeof steps === 'string') return invalid('required_steps', steps);
  if (params.ordered !== undefined && typeof params.ordered !== 'boolean') {
    return invalid('required_steps', 'ordered must be a boolean when provided');
  }
  const ordered = params.ordered !== false;

  const expected = ordered
    ? `steps appear in order: ${steps.map((step) => `/${step.source}/`).join(' → ')}`
    : `every step appears at least once: ${steps.map((step) => `/${step.source}/`).join(', ')}`;

  if (toolExecutions.length === 0) {
    return {
      passed: false,
      actual: 'zero tool calls recorded',
      expected,
      details: '过程记录里零次工具调用，必经步骤不可能命中——不许真空通过',
    };
  }

  const names = toolExecutions.map((record) => record.tool);
  if (!ordered) {
    const missing = steps.filter((step) => !names.some((name) => step.test(name)));
    return {
      passed: missing.length === 0,
      actual: missing.length === 0 ? 'all steps present' : `missing steps: ${missing.map((step) => `/${step.source}/`).join(', ')}`,
      expected,
      details: `无序判定：${steps.length} 步命中 ${steps.length - missing.length} 步（共 ${names.length} 次工具调用）`,
    };
  }

  let cursor = 0;
  const hitAt: number[] = [];
  for (const step of steps) {
    const found = names.findIndex((name, index) => index >= cursor && step.test(name));
    if (found === -1) break;
    hitAt.push(found);
    cursor = found + 1;
  }
  const passed = hitAt.length === steps.length;
  return {
    passed,
    actual: passed
      ? `steps hit at call indexes ${hitAt.join(' → ')}`
      : `step ${hitAt.length + 1} /${steps[hitAt.length]?.source}/ never matched after index ${cursor - 1}`,
    expected,
    details: `有序子序列判定：${steps.length} 步按序命中 ${hitAt.length} 步（共 ${names.length} 次工具调用）`,
  };
}
