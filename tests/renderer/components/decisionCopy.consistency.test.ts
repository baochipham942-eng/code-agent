import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('决策动作基底词', () => {
  it('中文以场景词开头、允许/拒绝收口', () => {
    expect(zh.decisionCard.swarm.optionApprove).toBe('团队启动 · 允许');
    expect(zh.decisionCard.swarm.optionReject).toBe('团队启动 · 拒绝');
    expect(zh.decisionCard.workflow.optionApprove).toBe('Workflow 启动 · 允许');
    expect(zh.planApproval.approve).toBe('计划 · 允许');
    expect(zh.planApproval.cancel).toBe('计划 · 拒绝');
    expect(zh.userQuestion.submit).toBe('回答 · 允许');
    expect(zh.userQuestion.skip).toBe('回答 · 拒绝');
    expect(zh.design.proposalApply).toBe('画布修改 · 允许');
    expect(zh.design.proposalReject).toBe('画布修改 · 拒绝');
  });

  it('英文以场景词开头、Allow/Deny 收口', () => {
    expect(en.decisionCard.swarm.optionApprove).toBe('Team launch · Allow');
    expect(en.decisionCard.swarm.optionReject).toBe('Team launch · Deny');
    expect(en.planApproval.approve).toBe('Plan · Allow');
    expect(en.planApproval.cancel).toBe('Plan · Deny');
    expect(en.userQuestion.submit).toBe('Answer · Allow');
    expect(en.userQuestion.skip).toBe('Answer · Deny');
    expect(en.design.proposalApply).toBe('Canvas edit · Allow');
    expect(en.design.proposalReject).toBe('Canvas edit · Deny');
  });
});
