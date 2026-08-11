// ============================================================================
// routingToolPolicy — 显式 /agent 路由的工具约束（Explorer 真只读）
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOL_READONLY_ROLES,
  READONLY_TOOL_DENYLIST,
  assembleTurnDenylist,
  buildRoutingToolDenylist,
  isToolWriteReadonlyRole,
} from '../../../src/host/agent/routingToolPolicy';

// live-voice 收窄逻辑经 assembleTurnDenylist 覆盖（buildLiveVoiceToolDenylist 已内联，
// 其它三源置空时结果纯由 live-voice 决定）。
describe('assembleTurnDenylist · live-voice 分支', () => {
  const presenceTools = ['AskUserQuestion', 'ask_user_question', 'ConfirmGenerationCost'];
  const voiceOnly = (isLiveVoiceSession: boolean, runRegistration: 'primary' | 'auxiliary') =>
    assembleTurnDenylist({
      agent: null,
      optionDenied: undefined,
      sessionMemoryMode: 'auto' as const,
      isLiveVoiceSession,
      runRegistration,
      userPresenceToolNames: presenceTools,
    });

  it('auxiliary voice run 只放行已有语音桥的选择题工具', () => {
    expect(voiceOnly(true, 'auxiliary')).toEqual(['ConfirmGenerationCost']);
  });

  it('primary voice run 继续禁用全部在场工具', () => {
    expect(voiceOnly(true, 'primary')).toEqual(presenceTools);
  });

  it('非通话 run 不施加通话 denylist（三源全空 → undefined）', () => {
    expect(voiceOnly(false, 'auxiliary')).toBeUndefined();
  });
});

describe('buildRoutingToolDenylist', () => {
  it('readonly agent → 拒掉全部文件写入工具（两种命名变体）', () => {
    const denied = buildRoutingToolDenylist({ readonly: true });
    for (const name of ['Write', 'write_file', 'Edit', 'edit_file', 'Append', 'append_file']) {
      expect(denied).toContain(name);
    }
  });

  it('非 readonly / 未标记 / 空 agent → 不加任何约束', () => {
    expect(buildRoutingToolDenylist({ readonly: false })).toEqual([]);
    expect(buildRoutingToolDenylist({})).toEqual([]);
    expect(buildRoutingToolDenylist(undefined)).toEqual([]);
    expect(buildRoutingToolDenylist(null)).toEqual([]);
  });

  it('denylist 与 spawnGuard 只读子代理语义一致（单一来源）', () => {
    expect(new Set(buildRoutingToolDenylist({ readonly: true }))).toEqual(new Set(READONLY_TOOL_DENYLIST));
  });
});

describe('isToolWriteReadonlyRole — 工具写只读判定（单一真源，spawn 两处共用）', () => {
  const core = (readonly: boolean) => ({ coordination: { readonly } });

  it('内置策展集里的角色 → 只读（reviewer 尽管 coordination.readonly=false 也算）', () => {
    // reviewer 是 execution 层（coordination.readonly=false），但审查员不该改文件 → 工具写只读。
    expect(isToolWriteReadonlyRole('reviewer', core(false))).toBe(true);
    expect(isToolWriteReadonlyRole('explore', core(true))).toBe(true);
    expect(isToolWriteReadonlyRole('explorer', undefined)).toBe(true);
  });

  it('内置 plan 尽管 coordination.readonly=true，也不是工具写只读（要写计划文档）', () => {
    // plan 是核心角色且不在策展集 → 不因 coordination.readonly=true 被误判。
    expect(isToolWriteReadonlyRole('plan', core(true))).toBe(false);
  });

  it('内置 coder → 不只读', () => {
    expect(isToolWriteReadonlyRole('coder', core(false))).toBe(false);
  });

  it('自定义 agent 声明 readonly:true → 只读（堵住旧名字清单的漏网）', () => {
    // 关键回归：自定义角色名不在硬编码清单里，旧实现下 readonly:true 形同虚设。
    expect(isToolWriteReadonlyRole('my-researcher', core(true))).toBe(true);
  });

  it('自定义 agent readonly:false / 无配置 → 不只读', () => {
    expect(isToolWriteReadonlyRole('my-writer', core(false))).toBe(false);
    expect(isToolWriteReadonlyRole('my-writer', undefined)).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isToolWriteReadonlyRole('Reviewer', core(false))).toBe(true);
    expect(isToolWriteReadonlyRole('EXPLORE', core(true))).toBe(true);
  });

  it('BUILTIN_TOOL_READONLY_ROLES 含 explore/explorer/reviewer，不含 plan', () => {
    expect(BUILTIN_TOOL_READONLY_ROLES).toContain('reviewer');
    expect(BUILTIN_TOOL_READONLY_ROLES).toContain('explore');
    expect(BUILTIN_TOOL_READONLY_ROLES).not.toContain('plan');
  });
});

describe('assembleTurnDenylist（三源去重组装）', () => {
  const base = {
    agent: null,
    optionDenied: undefined,
    sessionMemoryMode: 'auto' as const,
    isLiveVoiceSession: false,
    runRegistration: undefined,
    userPresenceToolNames: ['AskUser', 'ShowPanel'],
  };

  it('全空 → undefined（AgentLoop 只在非空时收 deniedToolNames）', () => {
    expect(assembleTurnDenylist(base)).toBeUndefined();
  });

  it('memoryMode=off → 并入 4 个记忆/历史工具', () => {
    const result = assembleTurnDenylist({ ...base, sessionMemoryMode: 'off' });
    expect(result).toEqual(expect.arrayContaining(['MemoryRead', 'MemoryWrite', 'History', 'EpisodicRecall']));
  });

  it('memoryMode=auto 不加记忆类；option 显式拒绝原样保留', () => {
    const result = assembleTurnDenylist({ ...base, optionDenied: ['Foo'] });
    expect(result).toEqual(['Foo']);
  });

  it('只读路由 agent → 并入 READONLY_TOOL_DENYLIST', () => {
    const result = assembleTurnDenylist({ ...base, agent: { readonly: true } });
    expect(result).toEqual(expect.arrayContaining([...READONLY_TOOL_DENYLIST]));
  });

  it('实时通话 primary run → 收窄在场工具', () => {
    const result = assembleTurnDenylist({ ...base, isLiveVoiceSession: true, runRegistration: 'primary' });
    expect(result).toEqual(expect.arrayContaining(['AskUser', 'ShowPanel']));
  });

  it('三源同时命中且去重：option 与 readonly 重叠的 Write 只出现一次', () => {
    const result = assembleTurnDenylist({
      ...base,
      optionDenied: ['Write', 'Foo'],
      agent: { readonly: true },
      sessionMemoryMode: 'off',
      isLiveVoiceSession: true,
      runRegistration: 'primary',
    });
    expect(result).toBeDefined();
    expect(result!.filter((n) => n === 'Write')).toHaveLength(1);
    // 三源都在
    expect(result).toEqual(expect.arrayContaining(['Foo', 'MemoryRead', 'Write', 'AskUser']));
  });
});
