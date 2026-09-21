// N-SKILL-TRIGGER-EVAL：skill 触发判定（skill_triggered / skill_not_triggered）单测。
// 判据 = skill_activated 事件计数（真实执行成功才算）；三层 fail-loud：
// 非法参数 / 无证据源 / 声明的 skill 没装进上下文（负样本防真空通过）。
import { describe, expect, it } from 'vitest';
import { evaluateSkillTriggerExpectation } from '../../../src/host/testing/skillTriggerEval';
import type { CaseSkillSignals } from '../../../src/host/testing/types';

function signals(activations: Record<string, number>, context: string[] = ['xlsx', 'meeting-summary', 'data-cleaning']): CaseSkillSignals {
  return { skillActivations: activations, skillContext: context };
}

describe('skill_triggered（正向 / 隐式触发题）', () => {
  it('名单里的 skill 真被触发 ⇒ 过', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx'] }, signals({ xlsx: 1 }));
    expect(result.passed).toBe(true);
    expect(result.actual).toEqual(['xlsx×1']);
  });

  it('mode=any 默认：任一命中即过', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx', 'meeting-summary'] }, signals({ 'meeting-summary': 2 }));
    expect(result.passed).toBe(true);
  });

  it('mode=all：只命中一部分 ⇒ 红', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx', 'meeting-summary'], mode: 'all' }, signals({ xlsx: 1 }));
    expect(result.passed).toBe(false);
    expect(result.expected).toContain('every declared skill');
  });

  it('该触发的没触发（计数为零）⇒ 红', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx'] }, signals({}));
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('no declared skill activated');
  });

  it('精确名匹配：xlsx-2 的触发不算 xlsx 触发（不子串命中）', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx'] }, signals({ 'xlsx-2': 3 }));
    expect(result.passed).toBe(false);
  });
});

describe('skill_not_triggered（负向 / 负样本题）', () => {
  it('名单内 skill 零触发 ⇒ 过', () => {
    const result = evaluateSkillTriggerExpectation('skill_not_triggered', { skills: ['xlsx', 'contract-review'] }, signals({}, ['xlsx', 'contract-review']));
    expect(result.passed).toBe(true);
  });

  it('误触发 ⇒ 红，且 actual 点出是谁触发了几次', () => {
    const result = evaluateSkillTriggerExpectation('skill_not_triggered', { skills: ['contract-review'] }, signals({ 'contract-review': 1 }, ['contract-review']));
    expect(result.passed).toBe(false);
    expect(result.actual).toEqual(['contract-review×1']);
  });

  it('别的 skill 触发了但不在名单里 ⇒ 不背锅，过', () => {
    const result = evaluateSkillTriggerExpectation('skill_not_triggered', { skills: ['xlsx'] }, signals({ brainstorm: 1 }));
    expect(result.passed).toBe(true);
  });

  it('mode 参数是正向专属：负向给了 ⇒ fail-loud', () => {
    const result = evaluateSkillTriggerExpectation('skill_not_triggered', { skills: ['xlsx'], mode: 'all' }, signals({}));
    expect(result.passed).toBe(false);
    expect(String(result.actual)).toContain('invalid params');
  });
});

describe('fail-loud 口径', () => {
  it('没有证据源（mock / 旧 adapter，signals 缺席）⇒ 两类型都显式红', () => {
    for (const type of ['skill_triggered', 'skill_not_triggered'] as const) {
      const result = evaluateSkillTriggerExpectation(type, { skills: ['xlsx'] }, undefined);
      expect(result.passed).toBe(false);
      expect(result.details).toContain('没有证据源');
    }
  });

  it('声明的 skill 没装进本题上下文 ⇒ 负向显式红（真空通过比红更危险）', () => {
    const result = evaluateSkillTriggerExpectation('skill_not_triggered', { skills: ['contract-review'] }, signals({}, ['xlsx']));
    expect(result.passed).toBe(false);
    expect(result.details).toContain('没装进本题上下文');
    expect(result.details).toContain('配置错');
  });

  it('声明的 skill 没装进本题上下文 ⇒ 正向显式红（永不可能触发，是配置错不是能力差）', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx'] }, signals({}, ['meeting-summary']));
    expect(result.passed).toBe(false);
    expect(result.details).toContain('没装进本题上下文');
  });

  it('skillContext 为空（本题什么 skill 都没装）⇒ 任何 skill 断言都红在上下文守卫上', () => {
    const result = evaluateSkillTriggerExpectation('skill_not_triggered', { skills: ['xlsx'] }, signals({}, []));
    expect(result.passed).toBe(false);
    expect(result.details).toContain('没装进本题上下文');
  });

  it.each([
    [{}, 'skills'],
    [{ skills: [] }, 'skills'],
    [{ skills: [''] }, 'skills'],
    [{ skills: [42] }, 'skills'],
  ])('非法参数 %j ⇒ 显式红，不静默过', (params, key) => {
    for (const type of ['skill_triggered', 'skill_not_triggered'] as const) {
      const result = evaluateSkillTriggerExpectation(type, params, signals({}));
      expect(result.passed).toBe(false);
      expect(String(result.actual)).toContain(key);
    }
  });

  it('mode 非法 ⇒ 显式红', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx'], mode: 'some' }, signals({ xlsx: 1 }));
    expect(result.passed).toBe(false);
    expect(String(result.actual)).toContain('invalid params');
  });

  it('skills 去重归一：重复名只算一条判据', () => {
    const result = evaluateSkillTriggerExpectation('skill_triggered', { skills: ['xlsx', 'xlsx'] }, signals({ xlsx: 1 }));
    expect(result.passed).toBe(true);
    expect(result.details).toContain('1 条判据');
  });
});
