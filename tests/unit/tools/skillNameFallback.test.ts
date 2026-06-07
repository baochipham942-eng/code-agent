import { describe, it, expect } from 'vitest';
import {
  resolveSkillByNameOrAlias,
  suggestClosestSkills,
} from '../../../src/main/tools/modules/skill/skill';
import type { ParsedSkill } from '../../../src/shared/contract/agentSkill';

// 最小 mock：兜底解析只读 name / aliases，其余字段用断言绕过
const mk = (name: string, aliases: string[] = []): ParsedSkill =>
  ({ name, aliases } as unknown as ParsedSkill);

const skills: ParsedSkill[] = [
  mk('context7', ['c7']),
  mk('design'),
  mk('frontend-design'),
  mk('multi-plan'),
];

describe('resolveSkillByNameOrAlias（精确兜底解析）', () => {
  it('大小写归一后精确命中', () => {
    expect(resolveSkillByNameOrAlias('Context7', skills)?.name).toBe('context7');
  });

  it('去除前导斜杠后命中', () => {
    expect(resolveSkillByNameOrAlias('/context7', skills)?.name).toBe('context7');
  });

  it('通过 frontmatter alias 命中（同样大小写归一）', () => {
    expect(resolveSkillByNameOrAlias('C7', skills)?.name).toBe('context7');
  });

  it('无任何匹配返回 undefined', () => {
    expect(resolveSkillByNameOrAlias('nonexistent-skill', skills)).toBeUndefined();
  });

  it('空白输入返回 undefined', () => {
    expect(resolveSkillByNameOrAlias('   ', skills)).toBeUndefined();
  });
});

describe('suggestClosestSkills（did-you-mean 近似建议）', () => {
  it('子串匹配排在最前（rank 0）', () => {
    const r = suggestClosestSkills('context', skills);
    expect(r[0]).toBe('context7');
  });

  it('编辑距离 ≤3 的拼写错误给出建议', () => {
    // 'contxt7' 与 'context7' 距离为 1
    expect(suggestClosestSkills('contxt7', skills)).toContain('context7');
  });

  it('距离过远不返回任何建议', () => {
    expect(suggestClosestSkills('zzzzzzzzzz', skills)).toEqual([]);
  });

  it('尊重 limit 上限', () => {
    const many = Array.from({ length: 10 }, (_, i) => mk(`planx${i}`));
    const r = suggestClosestSkills('planx', many, 3);
    expect(r.length).toBeLessThanOrEqual(3);
  });

  it('空白输入返回空数组', () => {
    expect(suggestClosestSkills('   ', skills)).toEqual([]);
  });
});
