// ============================================================================
// authoring skill 流程不该被内容生成提醒压住 —— 2026-07-23 真机回归钉
// ----------------------------------------------------------------------------
// 实测：用户提交「/create-team 写一篇微信推文」，这句话命中 isDocumentTask，
// DOCUMENT_GENERATION_WORKFLOW 的「不要用 AskUserQuestion 先问」被注入，
// 于是 create-team 该弹选项卡的澄清退化成两轮纯文本追问。
// 建团队/建角色/改角色这些 authoring skill 自带访谈规则，不该被写稿规则覆盖。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { createReminderContext } from '../../../src/host/prompts/dynamicReminders';
import { CONTENT_GENERATION_REMINDERS } from '../../../src/host/prompts/reminders/contentGeneration';

const DOCUMENT_PROMPT = '写一篇微信推文';
const PPT_PROMPT = '做一个 10 页的产品介绍 PPT';

function scoreOf(reminderId: string, prompt: string, activeSkillName?: string): number {
  const reminder = CONTENT_GENERATION_REMINDERS.find((item) => item.id === reminderId);
  if (!reminder) throw new Error(`提醒 ${reminderId} 不存在了——id 被改名了，先修这里`);
  return reminder.shouldInclude(createReminderContext(prompt, { activeSkillName }));
}

describe('内容生成提醒对 authoring skill 的豁免', () => {
  it('无 skill 时照常命中（先确认锚点没失效，避免后面的断言天然为 0）', () => {
    expect(scoreOf('DOCUMENT_GENERATION_WORKFLOW', DOCUMENT_PROMPT)).toBeGreaterThan(0);
    expect(scoreOf('PPT_FORMAT_SELECTION', PPT_PROMPT)).toBeGreaterThan(0);
  });

  it('create-team / create-role / edit-role 流程中不注入文档生成提醒', () => {
    for (const skill of ['create-team', 'create-role', 'edit-role']) {
      expect(scoreOf('DOCUMENT_GENERATION_WORKFLOW', DOCUMENT_PROMPT, skill)).toBe(0);
      expect(scoreOf('PPT_FORMAT_SELECTION', PPT_PROMPT, skill)).toBe(0);
    }
  });

  it('其他 skill 不受影响（豁免只给 authoring 三件套，不是给所有 skill）', () => {
    expect(scoreOf('DOCUMENT_GENERATION_WORKFLOW', DOCUMENT_PROMPT, 'deep-research')).toBeGreaterThan(0);
  });
});
