// ============================================================================
// applyMorningBriefSaveDraftRoleTools 直接单元测试
//
// FB-726：无邮件角色回「存草稿 N」时，旧实现只撤 mail_draft——mail_send 漏撤弹出发送
// 审批卡，delegate_task/Bash 绕后台真发信。这里钉函数本体的纯行为；编排器级真实路径
// （真 getTextForegroundToolNamesForPrompt 组成）在 tests/agent/agentOrchestrator.test.ts
// 的 morning brief save-draft role mail tool gate。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { applyMorningBriefSaveDraftRoleTools } from '../../../src/host/app/morningBriefSaveDraftTools';

const SAVE_DRAFT_PROMPT = '存草稿 1';
// 非存草稿轮（不命中 SAVE_DRAFT_REPLY_RE 的句首判据），同样命中邮件意图语境。
const OTHER_PROMPT = '帮我发邮件给 a@b.c，说明会议改期';
const NO_MAIL_REMOVE = ['mail', 'mail_send', 'mail_draft', 'delegate_task', 'Bash'] as const;
// 组成形状对齐真实轮：allowInTextForeground 基面（节选）+ 连接器意图扩展的 mail 三件套。
const FULL_LIST = [
  'Read', 'Write', 'Grep', 'AskUserQuestion', 'delegate_session',
  'mail', 'mail_send', 'mail_draft', 'delegate_task', 'Bash',
];

describe('applyMorningBriefSaveDraftRoleTools', () => {
  it('存草稿轮 + 无邮件角色：mail 三件套、delegate_task、Bash 全部撤下，其余原样保留', () => {
    const result = applyMorningBriefSaveDraftRoleTools(SAVE_DRAFT_PROMPT, [...FULL_LIST], ['Read']);
    expect(result).toEqual(['Read', 'Write', 'Grep', 'AskUserQuestion', 'delegate_session']);
    for (const absent of NO_MAIL_REMOVE) {
      expect(result).not.toContain(absent);
    }
  });

  it.each([['mail_draft'], ['mail']] as const)(
    '存草稿轮 + 角色声明 %s：名单原样返回（mail_send 不撤，角色真有邮件面）',
    (mailTool) => {
      expect(applyMorningBriefSaveDraftRoleTools(SAVE_DRAFT_PROMPT, [...FULL_LIST], ['Read', mailTool]))
        .toEqual(FULL_LIST);
    },
  );

  it('存草稿轮 + 未解析到角色：名单原样返回', () => {
    expect(applyMorningBriefSaveDraftRoleTools(SAVE_DRAFT_PROMPT, [...FULL_LIST], undefined))
      .toEqual(FULL_LIST);
    expect(applyMorningBriefSaveDraftRoleTools(SAVE_DRAFT_PROMPT, [...FULL_LIST], []))
      .toEqual(FULL_LIST);
  });

  it('非存草稿 prompt（即使命中邮件语境）：无邮件角色名单原样返回', () => {
    expect(applyMorningBriefSaveDraftRoleTools(OTHER_PROMPT, [...FULL_LIST], ['Read']))
      .toEqual(FULL_LIST);
  });

  it('allowedToolNames 为 undefined：返回 undefined（no-op 不造空名单）', () => {
    expect(applyMorningBriefSaveDraftRoleTools(SAVE_DRAFT_PROMPT, undefined, ['Read']))
      .toBeUndefined();
  });
});
