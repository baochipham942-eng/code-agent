// ============================================================================
// 一句话规则 K2：新档（preapprove / handback）与角色域的草稿校验 + 翻译编排
// ----------------------------------------------------------------------------
// validateDraft 走真实规则语法；translatePermissionSentence 用注入的假模型（固定 JSON）。
// 覆盖：preapprove 的 1-5 条 2-12 字无通配短语、受保护探针对 preapprove 同样拒、
// handback 可落在受保护命令上、短语只许出现在 preapprove、幻觉 roleId 被丢弃、
// 确认卡复述里列出短语与角色名。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { validateDraft } from '../../../src/host/permissions/permissionRuleDraft';
import { translatePermissionSentence } from '../../../src/host/permissions/permissionRuleTranslator';
import { NL_RULE_K2_TEXT } from '../../../src/shared/nlRuleRestate';

const CATALOG = ['Bash', 'Read', 'Edit', 'Write', 'mail_send'];
const ROLES = [{ id: 'finance', name: '财务助理' }];

function draft(overrides: Record<string, unknown> = {}): unknown {
  return {
    tool: 'Bash',
    pattern: 'npm run build *',
    behavior: 'preapprove',
    phrases: ['确认构建'],
    examples: { hit: ['npm run build --prod', 'npm run build -- --watch'], miss: ['git status', 'npm test'] },
    ...overrides,
  };
}

describe('validateDraft：preapprove 触发短语（K2）', () => {
  it('1-5 条 2-12 字无通配短语 → ok，短语原样带出', () => {
    const verdict = validateDraft(draft({ phrases: ['确认构建', '开始打包'] }), CATALOG);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.draft.phrases).toEqual(['确认构建', '开始打包']);
  });

  it.each([
    ['没有短语', undefined],
    ['空数组', []],
    ['6 条', ['短语一', '短语二', '短语三', '短语四', '短语五', '短语六']],
    ['1 个字', ['好']],
    ['13 个字', ['一二三四五六七八九十一二三']],
    ['含 * 通配', ['确认*']],
    ['含 ? 通配', ['确认?']],
  ])('%s → shape 拒绝', (_label, phrases) => {
    const verdict = validateDraft(draft(phrases === undefined ? { phrases: undefined } : { phrases }), CATALOG);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('shape');
  });

  it('非 preapprove 档带短语 → shape 拒绝', () => {
    const verdict = validateDraft(draft({ behavior: 'handback', phrases: ['确认构建'] }), CATALOG);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('shape');
  });

  it('handback 不需要短语，且接受工具名（无 pattern）', () => {
    const verdict = validateDraft(
      { tool: 'mail_send', behavior: 'handback', examples: { hit: ['任何'], miss: ['别的'] } },
      CATALOG,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('translatePermissionSentence：K2 编排', () => {
  it('preapprove + 点名角色 → ok，复述列出短语与角色名', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'ok', tool: 'Bash', pattern: 'npm run build *', behavior: 'preapprove',
      phrases: ['确认构建'], roleId: 'finance',
      examples: { hit: ['npm run build --prod', 'npm run build -- --watch'], miss: ['git status', 'npm test'] },
    }));
    const result = await translatePermissionSentence('财务助理 构建：只有我说确认构建才直接做', {
      chat, toolCatalog: CATALOG, roleCatalog: ROLES,
    });
    expect(result.status).toBe('ok');
    expect(result.behavior).toBe('preapprove');
    expect(result.roleId).toBe('finance');
    expect(result.phrases).toEqual(['确认构建']);
    expect(result.restatement).toContain('确认构建');
    expect(result.restatement).toContain(NL_RULE_K2_TEXT.scopeRole('财务助理'));
    // 系统提示把角色清单与 K2 两档告诉模型
    const system = (chat.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toContain('财务助理(finance)');
    expect(system).toContain('handback');
  });

  it('preapprove 命中受保护探针（git push）→ protected，不给 ok', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'ok', tool: 'Bash', pattern: 'git push *', behavior: 'preapprove', phrases: ['确认发布'],
      examples: { hit: ['git push origin main', 'git push --force'], miss: ['git status', 'git pull'] },
    }));
    const result = await translatePermissionSentence('只有我说确认发布才直接推代码', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('protected');
    expect(result.rule).toBe('Bash(git push *)');
  });

  it('handback 可以落在受保护探针上（本就不放行）→ ok', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'ok', tool: 'Bash', pattern: 'git push *', behavior: 'handback',
      examples: { hit: ['git push origin main', 'git push --force'], miss: ['git status', 'git pull'] },
    }));
    const result = await translatePermissionSentence('推代码这件事交回给我自己做', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('ok');
    expect(result.behavior).toBe('handback');
    expect(result.restatement).toContain('不算失败');
  });

  it('模型幻觉的 roleId（不在角色目录）→ 丢弃角色域，规则退化为全局', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'ok', tool: 'mail_send', behavior: 'handback', roleId: 'ghost-role',
      examples: { hit: ['任何'], miss: ['别的'] },
    }));
    const result = await translatePermissionSentence('发邮件交回给我', { chat, toolCatalog: CATALOG, roleCatalog: ROLES });
    expect(result.status).toBe('ok');
    expect(result.roleId).toBeUndefined();
  });

  it('preapprove 缺短语 → unrecognized（固定话术，不放行）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'ok', tool: 'Bash', pattern: 'npm run build *', behavior: 'preapprove',
      examples: { hit: ['npm run build --prod', 'npm run build -- --watch'], miss: ['git status', 'npm test'] },
    }));
    const result = await translatePermissionSentence('我说了才构建', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('unrecognized');
  });
});
