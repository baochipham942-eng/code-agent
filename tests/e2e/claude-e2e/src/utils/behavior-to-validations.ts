import { TestCase, ProcessValidation } from '../types.js';

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

  if (expectedBehavior.toolCallRange) {
    const { min, max } = expectedBehavior.toolCallRange;
    if (max !== undefined) {
      validations.push({ type: 'tool-count-max', count: max });
    }
    if (min !== undefined) {
      validations.push({ type: 'tool-count-min', count: min });
    }
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
