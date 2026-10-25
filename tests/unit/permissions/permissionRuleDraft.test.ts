// ============================================================================
// 一句话规则草稿的确定性校验（N-PERM-NL-RULES-K1）
// ----------------------------------------------------------------------------
// 覆盖：validateDraft（工具目录/规则语法/例子真伪）、受保护探针（allow 拒绝面）、
// 冲突取严、describeRule 人话复述。匹配语义全部走真实 parseToolSpecifier/matchSpecifier。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  isProtectedAllowRule,
  resolveRuleConflict,
  validateDraft,
} from '../../../src/host/permissions/permissionRuleDraft';
import { describeRule, NL_RULE_TEXT } from '../../../src/shared/permissionRuleTranslate';

const CATALOG = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ListDirectory',
  'WebFetch', 'mail_send', 'Skill', 'mcp__github__create_issue',
];

function draft(overrides: Record<string, unknown> = {}): unknown {
  return {
    tool: 'Bash',
    pattern: 'rm *',
    behavior: 'ask',
    examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
    ...overrides,
  };
}

describe('validateDraft', () => {
  it('接受命中/未命中都被真实匹配器验证过的草稿', () => {
    const verdict = validateDraft(draft(), CATALOG);
    expect(verdict).toEqual({
      ok: true,
      rule: 'Bash(rm *)',
      draft: {
        tool: 'Bash',
        pattern: 'rm *',
        behavior: 'ask',
        examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
      },
    });
  });

  it('工具目录只有大小写差异时按目录拼写规范化（bash → Bash）', () => {
    const verdict = validateDraft(draft({ tool: 'bash' }), CATALOG);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.rule).toBe('Bash(rm *)');
  });

  it('目录外的工具名与 mcp__server__tool 形态之外的拼写给 tool_unknown', () => {
    expect(validateDraft(draft({ tool: 'Terminal' }), CATALOG)).toMatchObject({ ok: false, reason: 'tool_unknown' });
    expect(validateDraft(draft({ tool: 'mcp__github' }), CATALOG)).toMatchObject({ ok: false, reason: 'tool_unknown' });
    const mcpDraft = draft({ tool: 'mcp__github__create_issue', pattern: undefined, examples: { hit: ['a'], miss: ['b'] } });
    expect(validateDraft(mcpDraft, [...CATALOG.slice(0, -1)])).toMatchObject({ ok: true });
  });

  it('形状不对（缺工具/行为/例子为空数组/缺 examples）给 shape', () => {
    expect(validateDraft({}, CATALOG)).toMatchObject({ ok: false, reason: 'shape' });
    expect(validateDraft(draft({ behavior: 'maybe' }), CATALOG)).toMatchObject({ ok: false, reason: 'shape' });
    expect(validateDraft(draft({ examples: { hit: [], miss: ['ls'] } }), CATALOG)).toMatchObject({ ok: false, reason: 'shape' });
    expect(validateDraft('Bash(rm *)', CATALOG)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('不支持 pattern 的工具带了 pattern → rule_invalid（specifier_not_supported）', () => {
    const verdict = validateDraft(draft({
      tool: 'mail_send',
      pattern: '*',
      examples: { hit: ['anything'], miss: ['other'] },
    }), CATALOG);
    expect(verdict).toMatchObject({ ok: false, reason: 'rule_invalid', detail: 'specifier_not_supported' });
  });

  it('hit 例子不被模式命中 / miss 例子被命中 → example_mismatch', () => {
    expect(validateDraft(draft({
      examples: { hit: ['ls -la', 'rm x'], miss: ['cat a'] },
    }), CATALOG)).toMatchObject({ ok: false, reason: 'example_mismatch', detail: 'hit example not matched: ls -la' });

    expect(validateDraft(draft({
      examples: { hit: ['rm x'], miss: ['rm -rf y'] },
    }), CATALOG)).toMatchObject({ ok: false, reason: 'example_mismatch', detail: 'miss example matched: rm -rf y' });
  });

  it('allow 语义按「整条命令每段都匹配」验证：复合命令里混进未匹配段不算命中', () => {
    const verdict = validateDraft(draft({
      behavior: 'allow',
      examples: { hit: ['rm -rf ./build', 'rm a; ls'], miss: ['ls'] },
    }), CATALOG);
    // 'rm a; ls' 的 ls 段不匹配 'rm *'，allow 语义下整条不算命中 → example_mismatch
    expect(verdict).toMatchObject({ ok: false, reason: 'example_mismatch' });
  });

  it('ask/deny 语义按 restrict 验证：复合命令里任一段命中即命中', () => {
    const verdict = validateDraft(draft({
      behavior: 'deny',
      examples: { hit: ['ls; rm -rf x'], miss: ['ls -la'] },
    }), CATALOG);
    expect(verdict).toMatchObject({ ok: true });
  });

  it('放行全部 Bash（裸名或等价全匹配）单列为 allow_all_bash', () => {
    expect(validateDraft(draft({
      pattern: undefined,
      behavior: 'allow',
      examples: { hit: ['ls'], miss: ['x'] },
    }), CATALOG)).toMatchObject({ ok: false, reason: 'allow_all_bash' });
    expect(validateDraft(draft({ pattern: '*', behavior: 'allow' }), CATALOG)).toMatchObject({ ok: false, reason: 'allow_all_bash' });
    // ask/deny 下的同名规则合法
    expect(validateDraft(draft({ pattern: undefined, behavior: 'ask' }), CATALOG)).toMatchObject({ ok: true });
  });

  it('空目录或异常巨大的目录直接判 tool_unknown（fail-closed）', () => {
    expect(validateDraft(draft(), [])).toMatchObject({ ok: false, reason: 'tool_unknown' });
    const hugeCatalog = Array.from({ length: 5000 }, (_, index) => `tool_${index}`);
    expect(validateDraft(draft(), hugeCatalog)).toMatchObject({ ok: false, reason: 'tool_unknown' });
  });
});

describe('isProtectedAllowRule（受保护动作探针）', () => {
  it('sudo / 删根 / force push / 系统文件写入的 allow 规则命中探针', () => {
    expect(isProtectedAllowRule('Bash(sudo *)')).toBe(true);
    expect(isProtectedAllowRule('Bash(rm -rf *)')).toBe(true);
    expect(isProtectedAllowRule('Bash(git push --force *)')).toBe(true);
    expect(isProtectedAllowRule('Bash(git push *)')).toBe(true);
    expect(isProtectedAllowRule('Write(/etc/*)')).toBe(true);
    expect(isProtectedAllowRule('Edit(/usr/**)')).toBe(true);
    expect(isProtectedAllowRule('Read(**/.ssh/**)')).toBe(true);
  });

  it('普通命令/项目内路径的 allow 规则不命中探针', () => {
    expect(isProtectedAllowRule('Bash(git status)')).toBe(false);
    expect(isProtectedAllowRule('Bash(npm test)')).toBe(false);
    expect(isProtectedAllowRule('Write(src/**)')).toBe(false);
    expect(isProtectedAllowRule('Edit(*.ts)')).toBe(false);
  });

  it('非命令/路径工具与裸名规则不进探针判定（裸 Bash allow 已由语法层拦）', () => {
    expect(isProtectedAllowRule('mail_send')).toBe(false);
    expect(isProtectedAllowRule('WebFetch')).toBe(false);
  });
});

describe('resolveRuleConflict（更严的赢）', () => {
  const hits = ['rm -rf ./build', 'rm notes.txt'];

  it('已存 deny 盖住新 allow 的全部 hit 例子 → 冲突，生效档 deny', () => {
    const conflict = resolveRuleConflict('Bash(rm *)', 'allow', hits, { deny: ['Bash(rm *)'] });
    expect(conflict).toEqual({
      existingRule: 'Bash(rm *)',
      existingBehavior: 'deny',
      effectiveBehavior: 'deny',
    });
  });

  it('已存 ask 盖住新 ask/allow → 生效档 ask；大小写不同的同名工具也算同一工具', () => {
    const conflict = resolveRuleConflict('Bash(rm *)', 'allow', hits, { ask: ['bash(rm *)'] });
    expect(conflict).toEqual({
      existingRule: 'bash(rm *)',
      existingBehavior: 'ask',
      effectiveBehavior: 'ask',
    });
  });

  it('裸工具名的更严规则盖住该工具全部请求（hit 例子空时也冲突）', () => {
    const conflict = resolveRuleConflict('mail_send', 'allow', [], { ask: ['mail_send'] });
    expect(conflict).toMatchObject({ existingBehavior: 'ask', effectiveBehavior: 'ask' });
  });

  it('更严规则没盖住 hit 例子 / 已存的是更松的档 → 不报冲突', () => {
    expect(resolveRuleConflict('Bash(rm *)', 'ask', hits, { deny: ['Bash(git push --force *)'] })).toBeUndefined();
    expect(resolveRuleConflict('Bash(rm *)', 'deny', hits, { allow: ['Bash(rm *)'] })).toBeUndefined();
    expect(resolveRuleConflict('Bash(rm *)', 'ask', hits, {})).toBeUndefined();
  });
});

describe('describeRule（代码生成的人话复述）', () => {
  it('走查原句：Bash(rm *) ask → 用终端运行 rm 开头的命令时 → 先问你', () => {
    expect(describeRule('Bash(rm *)', 'ask')).toBe('用终端运行 rm 开头的命令时 → 先问你');
  });

  it('行为短语与裸工具名/路径模式各有可读说法', () => {
    expect(describeRule('Bash(rm *)', 'deny')).toBe('用终端运行 rm 开头的命令时 → 一律禁止');
    expect(describeRule('Bash(rm *)', 'allow')).toBe('用终端运行 rm 开头的命令时 → 直接执行，不再询问');
    expect(describeRule('Bash', 'ask')).toBe('用终端运行任何命令时 → 先问你');
    expect(describeRule('Edit(.env*)', 'deny')).toBe('改动 .env 开头的文件时 → 一律禁止');
    expect(describeRule('Write(/etc/*)', 'deny')).toBe('写入 /etc 开头的文件时 → 一律禁止');
    expect(describeRule('Write(src/**)', 'ask')).toBe('写入 src 下的文件时 → 先问你');
    expect(describeRule('mail_send', 'ask')).toBe('发邮件时 → 先问你');
    expect(describeRule('WebFetch', 'allow')).toBe('访问网页时 → 直接执行，不再询问');
    expect(describeRule('mcp__github__create_issue', 'ask')).toBe('使用工具 mcp__github__create_issue时 → 先问你');
  });

  it('行为档标签（确认卡开关用）与话术同源', () => {
    expect(NL_RULE_TEXT.behavior).toEqual({ allow: '直接做', ask: '先问我', deny: '永不' });
  });
});
