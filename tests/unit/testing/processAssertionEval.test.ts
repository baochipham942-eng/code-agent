// N-EVAL-FAILURE-AUTOHARVEST：过程形状断言单测
// （max_tool_retries / handoff_proposed / handoff_not_proposed / required_steps）。
// 全部 deterministic 桶、fail-loud：非法参数 / 无证据源 / 真空通过都显式红。
import { describe, expect, it } from 'vitest';
import {
  evaluateHandoffExpectation,
  evaluateMaxToolRetriesExpectation,
  evaluateRequiredStepsExpectation,
} from '../../../src/host/testing/processAssertionEval';
import type { HandoffProposalRecord, ToolExecutionRecord } from '../../../src/host/testing/types';

function exec(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: 'Bash',
    input: { command: 'npm test' },
    output: '',
    success: true,
    duration: 10,
    timestamp: 1,
    ...overrides,
  };
}

function proposal(overrides: Partial<HandoffProposalRecord> = {}): HandoffProposalRecord {
  return {
    title: '转给设计专家继续',
    prompt: '接着把首页重做',
    source: 'assistant_tail',
    status: 'pending',
    createdAt: 1000,
    ...overrides,
  };
}

describe('max_tool_retries（retry 预算）', () => {
  it('同一签名连续失败未超预算 ⇒ 过', () => {
    const trace = [exec({ success: false }), exec({ success: false }), exec({ success: true })];
    const result = evaluateMaxToolRetriesExpectation({ budget: 2 }, trace);
    expect(result.passed).toBe(true);
  });

  it('同一签名连续失败超预算 ⇒ 红，actual 点出工具与连击数', () => {
    const trace = [exec({ success: false }), exec({ success: false }), exec({ success: false })];
    const result = evaluateMaxToolRetriesExpectation({ budget: 2 }, trace);
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('Bash failed 3 times in a row');
  });

  it('中间一次成功即清零：2 败 + 成功 + 2 败 不算超 3', () => {
    const trace = [
      exec({ success: false }), exec({ success: false }),
      exec({ success: true }),
      exec({ success: false }), exec({ success: false }),
    ];
    const result = evaluateMaxToolRetriesExpectation({ budget: 3 }, trace);
    expect(result.passed).toBe(true);
  });

  it('签名不同不算重试：同工具不同参数各失败一次 ⇒ 过', () => {
    const trace = [
      exec({ success: false, input: { command: 'a' } }),
      exec({ success: false, input: { command: 'b' } }),
    ];
    const result = evaluateMaxToolRetriesExpectation({ budget: 1 }, trace);
    expect(result.passed).toBe(true);
  });

  it('input 键序不影响签名（稳定序列化）', () => {
    const trace = [
      exec({ success: false, input: { a: 1, b: 2 } }),
      exec({ success: false, input: { b: 2, a: 1 } }),
    ];
    const result = evaluateMaxToolRetriesExpectation({ budget: 1 }, trace);
    expect(result.passed).toBe(false);
  });

  it('permissionDenied 不计入重试（没真执行）且打断连击', () => {
    const trace = [
      exec({ success: false }),
      exec({ success: false, permissionDenied: true }),
      exec({ success: false }),
    ];
    const result = evaluateMaxToolRetriesExpectation({ budget: 1 }, trace);
    expect(result.passed).toBe(true);
  });

  it('tool 过滤：只统计匹配的工具，不匹配的记录不连击', () => {
    const trace = [
      exec({ tool: 'Read', success: false }),
      exec({ tool: 'Read', success: false }),
      exec({ tool: 'Read', success: false }),
    ];
    const result = evaluateMaxToolRetriesExpectation({ budget: 1, tool: '^Bash$' }, trace);
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('no failing tool call streak');
  });

  it('空过程记录通过但 evidence 标明零次调用（不假扮查过）', () => {
    const result = evaluateMaxToolRetriesExpectation({ budget: 1 }, []);
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('zero tool calls recorded');
  });

  it('fail-loud：budget 缺失 / 非正整数 / tool 是非法 regex', () => {
    expect(evaluateMaxToolRetriesExpectation({}, []).passed).toBe(false);
    expect(evaluateMaxToolRetriesExpectation({ budget: 0 }, []).passed).toBe(false);
    expect(evaluateMaxToolRetriesExpectation({ budget: 1.5 }, []).passed).toBe(false);
    expect(evaluateMaxToolRetriesExpectation({ budget: 1, tool: '(' }, []).passed).toBe(false);
  });
});

describe('handoff_proposed / handoff_not_proposed（handoff 正确）', () => {
  it('该交接且有提案 ⇒ handoff_proposed 过', () => {
    const result = evaluateHandoffExpectation('handoff_proposed', {}, [proposal()]);
    expect(result.passed).toBe(true);
  });

  it('该交接但零提案 ⇒ handoff_proposed 红', () => {
    const result = evaluateHandoffExpectation('handoff_proposed', {}, []);
    expect(result.passed).toBe(false);
  });

  it('match 过滤：提案不匹配 ⇒ handoff_proposed 红', () => {
    const result = evaluateHandoffExpectation('handoff_proposed', { match: '视频' }, [proposal()]);
    expect(result.passed).toBe(false);
  });

  it('match 命中 reason 也算', () => {
    const result = evaluateHandoffExpectation('handoff_proposed', { match: '超长任务' }, [proposal({ reason: '超长任务接力' })]);
    expect(result.passed).toBe(true);
  });

  it('不该交接且零提案 ⇒ handoff_not_proposed 过', () => {
    const result = evaluateHandoffExpectation('handoff_not_proposed', {}, []);
    expect(result.passed).toBe(true);
  });

  it('不该交接却发了提案 ⇒ handoff_not_proposed 红，actual 点出提案', () => {
    const result = evaluateHandoffExpectation('handoff_not_proposed', {}, [proposal()]);
    expect(result.passed).toBe(false);
    expect(String(result.actual)).toContain('转给设计专家继续');
  });

  it('证据源缺席（undefined）⇒ 两个方向都 fail-loud', () => {
    const positive = evaluateHandoffExpectation('handoff_proposed', {}, undefined);
    const negative = evaluateHandoffExpectation('handoff_not_proposed', {}, undefined);
    expect(positive.passed).toBe(false);
    expect(negative.passed).toBe(false);
    expect(positive.details).toContain('没有证据源');
  });

  it('fail-loud：match 是非法 regex / 非字符串', () => {
    expect(evaluateHandoffExpectation('handoff_proposed', { match: '(' }, []).passed).toBe(false);
    expect(evaluateHandoffExpectation('handoff_not_proposed', { match: 42 }, []).passed).toBe(false);
  });
});

describe('required_steps（必经步骤）', () => {
  it('默认有序：子序列按序命中 ⇒ 过，actual 报命中位置', () => {
    const trace = [exec({ tool: 'Read' }), exec({ tool: 'Edit' }), exec({ tool: 'Bash' })];
    const result = evaluateRequiredStepsExpectation({ steps: ['^Read$', '^Bash$'] }, trace);
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('steps hit at call indexes 0 → 2');
  });

  it('有序：顺序反了 ⇒ 红', () => {
    const trace = [exec({ tool: 'Bash' }), exec({ tool: 'Read' })];
    const result = evaluateRequiredStepsExpectation({ steps: ['^Read$', '^Bash$'] }, trace);
    expect(result.passed).toBe(false);
  });

  it('ordered=false：乱序但全出现 ⇒ 过', () => {
    const trace = [exec({ tool: 'Bash' }), exec({ tool: 'Read' })];
    const result = evaluateRequiredStepsExpectation({ steps: ['^Read$', '^Bash$'], ordered: false }, trace);
    expect(result.passed).toBe(true);
  });

  it('ordered=false：缺一步 ⇒ 红，actual 点出缺哪步', () => {
    const trace = [exec({ tool: 'Read' })];
    const result = evaluateRequiredStepsExpectation({ steps: ['^Read$', '^Bash$'], ordered: false }, trace);
    expect(result.passed).toBe(false);
    expect(String(result.actual)).toContain('/^Bash$/');
  });

  it('空过程记录显式红（不许真空通过）', () => {
    const result = evaluateRequiredStepsExpectation({ steps: ['^Read$'] }, []);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('真空通过');
  });

  it('fail-loud：steps 缺失 / 空数组 / 含非法 regex / ordered 非布尔', () => {
    expect(evaluateRequiredStepsExpectation({}, [exec()]).passed).toBe(false);
    expect(evaluateRequiredStepsExpectation({ steps: [] }, [exec()]).passed).toBe(false);
    expect(evaluateRequiredStepsExpectation({ steps: ['('] }, [exec()]).passed).toBe(false);
    expect(evaluateRequiredStepsExpectation({ steps: ['^Read$'], ordered: 'yes' }, [exec()]).passed).toBe(false);
  });
});
