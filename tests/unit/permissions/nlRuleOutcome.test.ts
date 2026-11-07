// ============================================================================
// N-PERM-NL-RULES-K2 — 一句话规则的运行时档位（userRuleOutcome）+ run 盖章
// ----------------------------------------------------------------------------
// ① 引擎装载与判定序：deny > handback > ask > preapprove 未命中（=ask）> preapprove
//    命中；K1 旧表 ask 现在真的会在运行时强制弹审批（旧表 allow 不产生新放行捷径）。
// ③ 角色域：带 roleId 的规则只在该角色的 run 上命中（beginRunPolicy 盖章），主聊天
//    （无 roleId）与别的角色不命中；run 结束（endRunPolicy）盖章即清。
// ④ preapprove：发起话里出现任一触发短语 → 免询问；未出现 → 回落 ask；user-deny 仍赢。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { resolveUserRuleOutcomeForTool } from '../../../src/host/permissions/userRuleOutcome';

beforeEach(() => {
  resetPolicyEngine();
});

afterEach(() => {
  endRunPolicy('k2-run-a');
  endRunPolicy('k2-run-b');
  resetPolicyEngine();
});

describe('K2 判定序：deny > handback > ask > preapprove 未命中 > preapprove 命中', () => {
  it('同一工具命中多档时按序取最严一档（①）', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [
        { behavior: 'preapprove', rule: 'Bash(git push *)', phrases: ['让我推'] },
        { behavior: 'ask', rule: 'Bash(git push *)' },
        { behavior: 'handback', rule: 'Bash(git push *)' },
      ],
    });
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '让我推一把' });
    // handback 盖过 ask 与 preapprove（即使短语命中）
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'handback', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');

    // 去掉 handback 后 ask 盖过 preapprove 命中
    getPolicyEngine().loadUserRules({
      nlRules: [
        { behavior: 'preapprove', rule: 'Bash(git push *)', phrases: ['让我推'] },
        { behavior: 'ask', rule: 'Bash(git push *)' },
      ],
    });
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '让我推一把' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'ask', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');

    getPolicyEngine().loadUserRules({
      nlRules: [
        { behavior: 'preapprove', rule: 'Bash(git push *)', phrases: ['让我推'] },
        { behavior: 'handback', rule: 'Bash(git push *)' },
      ],
    });
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '让我推一把' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'handback', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');

    getPolicyEngine().loadUserRules({
      nlRules: [
        { behavior: 'preapprove', rule: 'Bash(git push *)', phrases: ['让我推'] },
        { behavior: 'deny', rule: 'Bash(git push *)' },
      ],
    });
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '让我推一把' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'denied', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');
  });

  it('旧表 deny 赢过 nlRules 的 handback/ask/preapprove（④：user-deny 仍赢）', () => {
    getPolicyEngine().loadUserRules({
      deny: ['Bash(git push *)'],
      nlRules: [
        { behavior: 'handback', rule: 'Bash(git push *)' },
        { behavior: 'preapprove', rule: 'Bash(git push *)', phrases: ['让我推'] },
      ],
    });
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '让我推一把' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'denied', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');
  });

  it('K1 旧表 ask 规则映射为 ask 档（①：运行时强制弹审批的判定输入）', () => {
    getPolicyEngine().loadUserRules({ ask: ['Bash(git status)'] });
    expect(resolveUserRuleOutcomeForTool(undefined, 'Bash', { command: 'git status' }))
      .toEqual({ kind: 'ask', rule: 'Bash(git status)' });
    expect(resolveUserRuleOutcomeForTool(undefined, 'Bash', { command: 'git push' })).toEqual({ kind: 'none' });
  });

  it('K1 旧表 allow 规则不产生新放行捷径（none）', () => {
    getPolicyEngine().loadUserRules({ allow: ['Bash(git status)'] });
    expect(resolveUserRuleOutcomeForTool(undefined, 'Bash', { command: 'git status' })).toEqual({ kind: 'none' });
  });
});

describe('preapprove：触发短语逐字匹配发起话（④）', () => {
  beforeEach(() => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'preapprove', rule: 'Bash(git push *)', phrases: ['让我推', '推上去'] }],
    });
  });

  it('发起话包含任一短语 → preapproved（带命中短语与规则）', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '改完了，让我推' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'preapproved', rule: 'Bash(git push *)', phrase: '让我推' });
    endRunPolicy('k2-run-a');
  });

  it('发起话没有短语 → 回落 ask（绝不静默放行）', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '帮我发布新版本' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'ask', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');
  });

  it('没有活跃 run（无发起话可匹配）→ 同样回落 ask', () => {
    expect(resolveUserRuleOutcomeForTool('k2-idle', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'ask', rule: 'Bash(git push *)' });
  });

  it('命令不被规则覆盖 → none', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '让我推' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'rm -rf /tmp/x' }))
      .toEqual({ kind: 'none' });
    endRunPolicy('k2-run-a');
  });
});

describe('角色域：roleId 盖章只在对应角色的 run 上命中（③）', () => {
  beforeEach(() => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'handback', rule: 'Bash(git push *)', roleId: 'ops-editor' }],
    });
  });

  it('该角色的 run 命中 handback', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: 'ops-editor', initiatingText: '发文章' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'handback', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');
  });

  it('主聊天（无 roleId）不命中', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: undefined, initiatingText: '发文章' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'none' });
    endRunPolicy('k2-run-a');
  });

  it('别的角色的 run 不命中', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: 'data-analyst', initiatingText: '发文章' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'none' });
    endRunPolicy('k2-run-a');
  });

  it('同会话最新活跃 run 的盖章被解析（子代理继承同一会话栈），run 结束即清', () => {
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: 'ops-editor', initiatingText: '发文章' });
    beginRunPolicy('k2-run-b', 'k2-session', { roleId: 'ops-editor', initiatingText: '继续发' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'handback', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-b');
    // 上一条 run 还在飞时退回上一条 run 的盖章（同栈最新活跃者赢）
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'handback', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');
    // 全部结束：盖章清空，角色域规则不再命中
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'none' });
  });

  it('全局规则（无 roleId）不受盖章影响', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'handback', rule: 'Bash(git push *)' }],
    });
    beginRunPolicy('k2-run-a', 'k2-session', { roleId: 'data-analyst', initiatingText: '发文章' });
    expect(resolveUserRuleOutcomeForTool('k2-session', 'Bash', { command: 'git push origin main' }))
      .toEqual({ kind: 'handback', rule: 'Bash(git push *)' });
    endRunPolicy('k2-run-a');
  });
});
