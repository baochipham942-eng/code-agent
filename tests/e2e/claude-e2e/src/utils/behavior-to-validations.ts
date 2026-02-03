import { TestCase, ProcessValidation, Complexity } from '../types.js';

/**
 * 根据复杂度等级计算工具调用上限
 *
 * 基准值：
 * - L1/L2: 简单任务，基础上限
 * - L3/L4: 中等任务，适度增加
 * - L5/L6: 复杂任务，大幅增加
 *
 * 额外加成：
 * - 每个 step 增加 8 次调用（读+写+验证+重试）
 */
export function calculateToolCallMax(complexity: Complexity, stepsCount: number = 0): number {
  const baseMax: Record<Complexity, number> = {
    L1: 20,
    L2: 35,
    L3: 50,
    L4: 70,
    L5: 100,
    L6: 150,
  };

  const base = baseMax[complexity] || 50;
  const stepsBonus = stepsCount * 8; // 每步约 8 次调用

  return base + stepsBonus;
}

/**
 * 将 expectedBehavior 快捷定义转换为完整的 processValidations
 */
export function expandExpectedBehavior(testCase: TestCase): ProcessValidation[] {
  const { expectedBehavior } = testCase;
  if (!expectedBehavior) return testCase.processValidations || [];

  const validations: ProcessValidation[] = [
    ...(testCase.processValidations || []),
  ];

  if (expectedBehavior.directExecution === true) {
    validations.push({
      type: 'agent-not-dispatched',
      message: `${testCase.complexity} 任务应由主 agent 直接完成`,
    });
  }

  if (expectedBehavior.directExecution === false) {
    validations.push({
      type: 'agent-dispatched',
      message: `${testCase.complexity} 任务应分派子 agent`,
    });
  }

  if (expectedBehavior.expectedAgents?.length) {
    validations.push({
      type: 'agent-type',
      agentType: expectedBehavior.expectedAgents,
    });
  }

  if (expectedBehavior.requiredTools?.length) {
    validations.push({
      type: 'tool-used',
      tool: expectedBehavior.requiredTools,
    });
  }

  if (expectedBehavior.forbiddenTools?.length) {
    validations.push({
      type: 'tool-not-used',
      tool: expectedBehavior.forbiddenTools,
    });
  }

  // 工具调用次数限制
  const stepsCount = testCase.steps?.length || 0;
  const calculatedMax = calculateToolCallMax(testCase.complexity, stepsCount);

  if (expectedBehavior.toolCallRange) {
    const { min, max } = expectedBehavior.toolCallRange;
    // 使用显式指定的 max，或使用计算值
    const effectiveMax = max !== undefined ? max : calculatedMax;
    validations.push({ type: 'tool-count-max', count: effectiveMax });

    if (min !== undefined) {
      validations.push({ type: 'tool-count-min', count: min });
    }
  } else {
    // 未指定 toolCallRange 时，使用复杂度计算的默认上限
    validations.push({ type: 'tool-count-max', count: calculatedMax });
  }

  if (expectedBehavior.toolPattern) {
    validations.push({
      type: 'tool-sequence',
      sequence: expectedBehavior.toolPattern.split('.*'),
    });
  }

  // 默认添加通用验证
  const hasNoBlindEdit = validations.some((v) => v.type === 'no-blind-edit');
  if (!hasNoBlindEdit) {
    validations.push({ type: 'no-blind-edit' });
  }

  return validations;
}
