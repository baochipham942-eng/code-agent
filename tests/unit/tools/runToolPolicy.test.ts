import { describe, expect, it } from 'vitest';
import {
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
});
