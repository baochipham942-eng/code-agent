import { describe, expect, it } from 'vitest';
import {
  HARNESS_KNOB_DEFAULTS,
  getHarnessKnob,
  runWithHarnessKnobs,
  validateHarnessKnobs,
  validateHarnessProfile,
  type HarnessKnobKey,
} from '../../../src/host/agent/runtime/harnessKnobs';
import { SUBAGENT_COMPACTION, SYSTEM_PROMPT_BUDGET } from '../../../src/shared/constants/agent';
import { getSystemPromptBudget } from '../../../src/host/agent/runtime/contextAssembly/shared';

const resolveHarnessKnobs = () => Object.fromEntries(
  (Object.keys(HARNESS_KNOB_DEFAULTS) as HarnessKnobKey[]).map((key) => [key, getHarnessKnob(key)]),
);

describe('harnessKnobs', () => {
  it('默认值就是原来的字面量（验收④：无 profile 时逐字回到现状）', () => {
    expect(HARNESS_KNOB_DEFAULTS['subagent.compactionThreshold']).toBe(SUBAGENT_COMPACTION.THRESHOLD);
    expect(HARNESS_KNOB_DEFAULTS['subagent.compactionThreshold']).toBe(0.8);
    expect(HARNESS_KNOB_DEFAULTS['context.persistentSystemContextTokens']).toBe(1200);
    expect(HARNESS_KNOB_DEFAULTS['context.systemPromptMinTokens']).toBe(SYSTEM_PROMPT_BUDGET.MIN_TOKENS);
    expect(HARNESS_KNOB_DEFAULTS['context.systemPromptMinTokens']).toBe(6000);
    expect(resolveHarnessKnobs()).toEqual(HARNESS_KNOB_DEFAULTS);
  });

  it('覆盖只活在作用域里，出作用域即回滚；空表直接透传', () => {
    const inside = runWithHarnessKnobs({ 'context.persistentSystemContextTokens': 300 }, () => getHarnessKnob('context.persistentSystemContextTokens'));
    expect(inside).toBe(300);
    expect(getHarnessKnob('context.persistentSystemContextTokens')).toBe(1200);
    expect(runWithHarnessKnobs({}, () => resolveHarnessKnobs())).toEqual(HARNESS_KNOB_DEFAULTS);
    expect(runWithHarnessKnobs(undefined, () => resolveHarnessKnobs())).toEqual(HARNESS_KNOB_DEFAULTS);
  });

  it('嵌套作用域内层覆盖外层，其余键继承', () => {
    runWithHarnessKnobs({ 'subagent.compactionThreshold': 0.5, 'context.systemPromptMinTokens': 7000 }, () => {
      runWithHarnessKnobs({ 'subagent.compactionThreshold': 0.6 }, () => {
        expect(resolveHarnessKnobs()).toEqual({
          'subagent.compactionThreshold': 0.6,
          'context.persistentSystemContextTokens': 1200,
          'context.systemPromptMinTokens': 7000,
        });
      });
      expect(getHarnessKnob('subagent.compactionThreshold')).toBe(0.5);
    });
  });

  it('覆盖穿到真实消费点：system prompt 预算下限跟旋钮走', () => {
    const baseline = getSystemPromptBudget();
    expect(baseline).toBe(6000);
    expect(runWithHarnessKnobs({ 'context.systemPromptMinTokens': 9000 }, () => getSystemPromptBudget())).toBe(9000);
    expect(getSystemPromptBudget()).toBe(baseline);
  });

  it('校验：未知键、非正数、比例越界一律拒收', () => {
    expect(() => validateHarnessKnobs({ 'nope.key': 1 })).toThrow(/未知旋钮/);
    expect(() => validateHarnessKnobs({ 'context.persistentSystemContextTokens': 0 })).toThrow(/正有限数/);
    expect(() => validateHarnessKnobs({ 'context.persistentSystemContextTokens': Number.NaN })).toThrow(/正有限数/);
    expect(() => validateHarnessKnobs({ 'subagent.compactionThreshold': 1.5 })).toThrow(/比例/);
    expect(() => validateHarnessKnobs([])).toThrow(/对象/);
    expect(validateHarnessKnobs({ 'subagent.compactionThreshold': 0.7 })).toEqual({ 'subagent.compactionThreshold': 0.7 });
  });

  it('profile 文件级：顶层非对象 / 缺 knobs 键一律拒，不许静默按默认跑（PR#1769 R3）', () => {
    expect(() => validateHarnessProfile([])).toThrow(/顶层必须是对象/);
    expect(() => validateHarnessProfile(null)).toThrow(/顶层必须是对象/);
    expect(() => validateHarnessProfile({})).toThrow(/缺少 knobs/);
    expect(() => validateHarnessProfile({ knobs: [] })).toThrow(/必须是对象/);
    expect(() => validateHarnessProfile({ knobs: { bogus: 1 } })).toThrow(/未知旋钮/);
    expect(validateHarnessProfile({ knobs: { 'subagent.compactionThreshold': 0.7 } })).toEqual({ 'subagent.compactionThreshold': 0.7 });
  });
});
