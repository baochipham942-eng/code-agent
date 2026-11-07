import { describe, expect, it } from 'vitest';
import {
  couldMcpServerToolsSurviveRunPolicy,
  isToolDeniedByRunPolicy,
  narrowToolNamesByRunPolicy,
  type RunToolPolicy,
} from '../../../src/host/tools/runToolPolicy';

// Run 级工具面纯函数语义：CLI --tools/--disallowed-tools、ToolExecutor 兜底闸、
// spawn_agent 子代理交集共用同一份实现。
describe('runToolPolicy (pure)', () => {
  it('denylist 大小写不敏感命中', () => {
    const policy = { deniedToolNames: ['Bash'] };
    expect(isToolDeniedByRunPolicy(policy, 'bash')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'BASH')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'Read')).toBe(false);
  });

  it('skill:<name> 原名直接匹配', () => {
    const policy = { deniedToolNames: ['skill:pdf'] };
    expect(isToolDeniedByRunPolicy(policy, 'skill:pdf')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'skill:docx')).toBe(false);
  });

  it('allowlist 非空 = 精确白名单：名单外一律禁用，无核心工具兜底', () => {
    const policy = { allowedToolNames: ['Read', 'skill:pdf'] };
    expect(isToolDeniedByRunPolicy(policy, 'Read')).toBe(false);
    expect(isToolDeniedByRunPolicy(policy, 'skill:pdf')).toBe(false);
    expect(isToolDeniedByRunPolicy(policy, 'Bash')).toBe(true);
    // AskUserQuestion 等交互工具也不豁免——白名单是字面全集
    expect(isToolDeniedByRunPolicy(policy, 'AskUserQuestion')).toBe(true);
  });

  it('deny 优先于 allow（同一名单同时命中时禁用）', () => {
    const policy = { allowedToolNames: ['Read', 'Bash'], deniedToolNames: ['bash'] };
    expect(isToolDeniedByRunPolicy(policy, 'Bash')).toBe(true);
    expect(isToolDeniedByRunPolicy(policy, 'Read')).toBe(false);
  });

  it('空名单（全空白条目）等同于未设置', () => {
    const policy = { allowedToolNames: ['  '], deniedToolNames: [''] };
    expect(isToolDeniedByRunPolicy(policy, 'Bash')).toBe(false);
  });

  it('workbench toolScope 豁免连接器工具，但不放宽显式 deny', () => {
    const policy: RunToolPolicy = {
      allowedToolNames: ['Read'],
      toolScope: { allowedConnectorIds: ['tmeet'] },
    };
    expect(isToolDeniedByRunPolicy(policy, 'tmeetMeetingList')).toBe(false);
    expect(isToolDeniedByRunPolicy(policy, 'Bash')).toBe(true);

    const withDeny: RunToolPolicy = { ...policy, deniedToolNames: ['tmeetMeetingList'] };
    expect(isToolDeniedByRunPolicy(withDeny, 'tmeetMeetingList')).toBe(true);
  });

  it('narrowToolNamesByRunPolicy 保序收窄（子代理只能收窄不能扩张）', () => {
    const policy = { allowedToolNames: ['Read', 'Bash'], deniedToolNames: ['bash'] };
    expect(narrowToolNamesByRunPolicy(['Bash', 'Read', 'Edit'], policy)).toEqual(['Read']);
  });

  it('narrowToolNamesByRunPolicy 无策略时原样返回', () => {
    expect(narrowToolNamesByRunPolicy(['Bash', 'Read'], {})).toEqual(['Bash', 'Read']);
  });

  it('couldMcpServerToolsSurviveRunPolicy：白名单不含该 server ⇒ 跳过；含精确名/glob/toolScope/无白名单 ⇒ 连', () => {
    expect(couldMcpServerToolsSurviveRunPolicy('slow', { allowedToolNames: ['Read'] })).toBe(false);
    expect(couldMcpServerToolsSurviveRunPolicy('slow', {
      allowedToolNames: ['Read', 'mcp__slow__work'],
    })).toBe(true);
    expect(couldMcpServerToolsSurviveRunPolicy('slow', {
      allowedToolNames: ['Read', 'mcp__slow__*'],
    })).toBe(true);
    expect(couldMcpServerToolsSurviveRunPolicy('slow', {
      allowedToolNames: ['Read'],
      toolScope: { allowedMcpServerIds: ['slow'] },
    })).toBe(true);
    expect(couldMcpServerToolsSurviveRunPolicy('slow', {})).toBe(true);
    expect(couldMcpServerToolsSurviveRunPolicy('slow', { deniedToolNames: ['mcp__slow__*'] })).toBe(true);
  });

  // FB-327：create-role 跟进轮撞上会话指挥台前台白名单时，strict 流程面工具被静默
  // 裁掉 → 模型只能念稿停摆。skillBoundaryAllowedTools 是白名单的合法补充（同 toolScope 档）。
  it('skillBoundaryAllowedTools 豁免 strict 流程面工具穿过前台白名单', () => {
    const foregroundFace: RunToolPolicy = {
      allowedToolNames: ['AskUserQuestion', 'Glob', 'Grep', 'Read'],
      skillBoundaryAllowedTools: ['propose_role', 'exit_role_flow', 'list_experts', 'AskUserQuestion', 'Read', 'Glob', 'Grep'],
    };
    expect(isToolDeniedByRunPolicy(foregroundFace, 'propose_role')).toBe(false);
    expect(isToolDeniedByRunPolicy(foregroundFace, 'LIST_EXPERTS')).toBe(false);
    // 白名单语义对其它工具不变
    expect(isToolDeniedByRunPolicy(foregroundFace, 'Bash')).toBe(true);
  });

  it('skillBoundaryAllowedTools 不放宽显式 deny（deny 一票否决保持）', () => {
    const policy: RunToolPolicy = {
      allowedToolNames: ['Read'],
      deniedToolNames: ['propose_role'],
      skillBoundaryAllowedTools: ['propose_role'],
    };
    expect(isToolDeniedByRunPolicy(policy, 'propose_role')).toBe(true);
  });
});
