// ============================================================================
// 一句话 → 草稿的翻译编排（N-PERM-NL-RULES-K1）
// ----------------------------------------------------------------------------
// chat 全部注入假模型（返回固定 JSON 字符串），只验证编排逻辑：
// JSON 提取、模型自报 unrecognized、确定性校验失败落 unrecognized、
// allow_all_bash / 受保护探针落 protected、冲突取严、复述由 describeRule 生成。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import {
  PermissionTranslateParseError,
  translatePermissionSentence,
} from '../../../src/host/permissions/permissionRuleTranslator';
import { NL_RULE_TEXT } from '../../../src/shared/permissionRuleTranslate';

const CATALOG = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ListDirectory', 'WebFetch', 'mail_send'];

function chatReturning(raw: string) {
  return vi.fn().mockResolvedValue(raw);
}

const RM_DRAFT_JSON = JSON.stringify({
  status: 'ok',
  tool: 'Bash',
  pattern: 'rm *',
  behavior: 'ask',
  examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
});

describe('translatePermissionSentence', () => {
  it('可翻译句子 → ok + 规则串 + 代码生成的复述 + 已验证例子', async () => {
    const chat = chatReturning(RM_DRAFT_JSON);
    const result = await translatePermissionSentence('删文件之前先问我', { chat, toolCatalog: CATALOG });
    expect(result).toEqual({
      status: 'ok',
      draft: {
        tool: 'Bash',
        pattern: 'rm *',
        behavior: 'ask',
        examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
      },
      rule: 'Bash(rm *)',
      behavior: 'ask',
      restatement: '用终端运行 rm 开头的命令时 → 先问你',
      examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
    });
    // 系统提示把工具清单带给模型，用户句子原样进 user 轮
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain('Bash');
    expect(messages[1].content).toBe('删文件之前先问我');
  });

  it('裸具名工具（无 pattern）→ ok，不带例子字段', async () => {
    const chat = chatReturning(JSON.stringify({
      status: 'ok',
      tool: 'mail_send',
      behavior: 'ask',
      examples: { hit: ['任何'], miss: ['别的工具'] },
    }));
    const result = await translatePermissionSentence('以后发邮件前都要先问我', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('ok');
    expect(result.rule).toBe('mail_send');
    expect(result.restatement).toBe('发邮件时 → 先问你');
    expect(result.examples).toBeUndefined();
  });

  it('模型自报 unrecognized → 固定话术，不透传模型自由文本', async () => {
    const chat = chatReturning(JSON.stringify({ status: 'unrecognized', reason: '涉及客户隐私无法映射' }));
    const result = await translatePermissionSentence('涉及客户隐私的事先问我', { chat, toolCatalog: CATALOG });
    expect(result).toEqual({
      status: 'unrecognized',
      reasonText: NL_RULE_TEXT.unrecognizedReason,
    });
    expect(result.reasonText).toContain('这条我没法可靠识别');
  });

  it('草稿确定性校验失败（工具不在目录）→ unrecognized', async () => {
    const chat = chatReturning(JSON.stringify({
      status: 'ok',
      tool: 'PrivacyFilter',
      behavior: 'ask',
      examples: { hit: ['a'], miss: ['b'] },
    }));
    const result = await translatePermissionSentence('涉及客户隐私的事先问我', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('unrecognized');
    expect(result.reasonText).toBe(NL_RULE_TEXT.unrecognizedReason);
  });

  it('草稿例子被真实匹配器证伪（hit 不命中）→ unrecognized', async () => {
    const chat = chatReturning(JSON.stringify({
      status: 'ok',
      tool: 'Bash',
      pattern: 'rm *',
      behavior: 'ask',
      examples: { hit: ['git status'], miss: ['ls'] },
    }));
    const result = await translatePermissionSentence('随便什么', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('unrecognized');
  });

  it('sudo 直接放行 → protected（确定性探针拒绝，区别于识别不了）', async () => {
    const chat = chatReturning(JSON.stringify({
      status: 'ok',
      tool: 'Bash',
      pattern: 'sudo *',
      behavior: 'allow',
      examples: { hit: ['sudo apt-get install build-essential'], miss: ['apt-get install x'] },
    }));
    const result = await translatePermissionSentence('sudo 命令直接放行', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('protected');
    expect(result.rule).toBe('Bash(sudo *)');
    expect(result.reasonText).toBe(NL_RULE_TEXT.protectedReason);
    expect(result.reasonText).toContain('不会帮你设成自动放行');
  });

  it('allow-all Bash → protected 而不是 unrecognized', async () => {
    const chat = chatReturning(JSON.stringify({
      status: 'ok',
      tool: 'Bash',
      pattern: '*',
      behavior: 'allow',
      examples: { hit: ['ls'], miss: ['sudo rm -rf /'] },
    }));
    const result = await translatePermissionSentence('终端命令全部直接放行', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('protected');
    expect(result.reasonText).toBe(NL_RULE_TEXT.protectedReason);
  });

  it('与已存 deny 冲突 → 报更严那条，行为档上调为 deny', async () => {
    const chat = chatReturning(RM_DRAFT_JSON);
    const result = await translatePermissionSentence('删文件之前先问我', {
      chat,
      toolCatalog: CATALOG,
      existingRules: { deny: ['Bash(rm *)'] },
    });
    expect(result.status).toBe('ok');
    expect(result.behavior).toBe('deny');
    expect(result.conflict).toEqual({
      existingRule: 'Bash(rm *)',
      existingBehavior: 'deny',
      effectiveBehavior: 'deny',
    });
    expect(result.reasonText).toContain('更严的那条会生效');
    expect(result.restatement).toBe('用终端运行 rm 开头的命令时 → 一律禁止');
  });

  it('不传 existingRules 时不做冲突判定', async () => {
    const chat = chatReturning(RM_DRAFT_JSON);
    const result = await translatePermissionSentence('删文件之前先问我', { chat, toolCatalog: CATALOG });
    expect(result.conflict).toBeUndefined();
    expect(result.behavior).toBe('ask');
  });

  it('模型返回非 JSON → 抛 PermissionTranslateParseError（可重试的格式故障）', async () => {
    const chat = chatReturning('我觉得你应该先问用户');
    await expect(translatePermissionSentence('删文件之前先问我', { chat, toolCatalog: CATALOG }))
      .rejects.toBeInstanceOf(PermissionTranslateParseError);
  });

  it('模型通道故障向上抛（ipc 层转 MODEL_UNAVAILABLE）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('no api key'));
    await expect(translatePermissionSentence('删文件之前先问我', { chat, toolCatalog: CATALOG }))
      .rejects.toThrow('no api key');
  });

  it('模型输出包了 markdown 围栏也能提出 JSON', async () => {
    const chat = chatReturning(`好的，这是结果：\n\`\`\`json\n${RM_DRAFT_JSON}\n\`\`\``);
    const result = await translatePermissionSentence('删文件之前先问我', { chat, toolCatalog: CATALOG });
    expect(result.status).toBe('ok');
    expect(result.rule).toBe('Bash(rm *)');
  });
});
