// ============================================================================
// Permission Inheritance — 6 AC Scenarios (plan §2)
//
// 集成测试覆盖 plan §2 的 6 个 AC 验收标准：
//
//   AC-1 (场景 A): plan 模式主 agent spawn coder → permission denied
//   AC-2 (场景 B): 用户 settings.permissions.deny 规则继承到 subagent
//   AC-3 (场景 C): CI 模式 deny 集合自动继承到 subagent
//   AC-4 (场景 D): reviewer/explorer 父禁止 spawn writer 子
//   AC-5         : 无 parentContext 的旧 caller fallback 不破坏
//   AC-6         : 合并算法（tools ∩、deny ∪、mode 取严）— 已在 tests/agent
//                  的 unit test 验证过；这里再以集成视角跑一次正反双跑
//
// 每个 AC 都包含正向（应 deny）+ 反向（应 allow）双跑用例，避免 false-positive
// （e.g. "deny 永远命中" 但其实是规则配错）。
//
// 实现说明：
//   - tool 名按 PolicyEngine 的命名约定（Bash/Write/...）传，与 parseToolSpecifier
//     一致，否则 matcher.tool 比较会 case-mismatch 失败。
//   - prompts/builder 被 mock 掉（与 tests/agent/permissionInheritance.test.ts
//     对齐），避免 getModeReminder 对 'default' 字符串报错（'default' 不在
//     AgentMode 枚举里）。
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/host/prompts/builder', () => ({
  buildProfilePrompt: vi.fn(() => 'mocked-prompt'),
}));

import {
  buildChildContext,
  buildParentContextFromToolContext,
  checkReadonlyParentRule,
  type ParentContext,
} from '../../../src/host/agent/childContext';
import {
  getPolicyEngine,
  resetPolicyEngine,
} from '../../../src/host/permissions/policyEngine';
import {
  getGuardFabric,
  resetGuardFabric,
} from '../../../src/host/permissions/guardFabric';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeParent(overrides: Partial<ParentContext> = {}): ParentContext {
  return {
    rules: [],
    memory: [],
    hooks: [],
    skills: [],
    mcpConnections: [],
    permissionMode: 'default',
    availableTools: ['Read', 'Grep', 'Bash', 'Write', 'Edit', 'WebFetch'],
    deny: [],
    ask: [],
    allow: [],
    blockedCommands: [],
    ...overrides,
  };
}

beforeEach(() => {
  // 每个 AC 独立的 PolicyEngine + GuardFabric，避免 user rules 跨用例泄漏
  resetPolicyEngine();
  resetGuardFabric();
});

// ============================================================================
// AC-1 / 场景 A: plan→coder readonly 子集塌方
// ============================================================================

describe('AC-1 (场景 A): plan 模式主 agent spawn coder → permission denied', () => {
  it('正向：plan 父（readonly 工具集）spawn coder 子 → toolPool 不含写工具', () => {
    const parent = makeParent({
      permissionMode: 'plan',
      availableTools: ['Read', 'Grep'], // plan 模式下只暴露 readonly 工具
      role: 'plan',
    });
    const child = {
      agentType: 'coder',
      allowedTools: ['Read', 'Grep', 'Bash', 'Write', 'Edit'],
    };

    const ctx = buildChildContext(child, parent, { inheritance: 'strict-inherit' });

    // 关键断言：子的 toolPool 一定不包含写工具，因为父没有
    expect(ctx.toolPool).not.toContain('Bash');
    expect(ctx.toolPool).not.toContain('Write');
    expect(ctx.toolPool).not.toContain('Edit');
    expect(ctx.toolPool).toEqual(['Read', 'Grep']);

    // mode 取更严：plan 比 default 更严，子继承 plan
    expect(ctx.permissions.effectiveMode).toBe('plan');
  });

  it('正向（topology hard rule 兜底）：plan 父禁止 spawn 带 write capability 的子', () => {
    const r = checkReadonlyParentRule('plan', 'general', ['write']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cannot spawn child with 'write' capability/);
  });

  it('反向：default 模式主 agent spawn coder → toolPool 含写工具', () => {
    const parent = makeParent({
      permissionMode: 'default',
      availableTools: ['Read', 'Grep', 'Bash', 'Write', 'Edit'],
      role: 'coder',
    });
    const child = {
      agentType: 'coder',
      allowedTools: ['Read', 'Grep', 'Bash', 'Write', 'Edit'],
    };
    const ctx = buildChildContext(child, parent, { inheritance: 'strict-inherit' });
    // 父非 readonly，子能拿到 Bash/Write/Edit
    expect(ctx.toolPool).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    expect(ctx.permissions.effectiveMode).toBe('default');
  });
});

// ============================================================================
// AC-2 / 场景 B: 用户 settings.permissions.deny 级联到 subagent
// ============================================================================

describe('AC-2 (场景 B): user deny rules 通过 GuardFabric 传递到 subagent', () => {
  it('正向：用户 deny Bash(rm -rf *) → GuardFabric 在 subagent topology 也 deny', () => {
    // 模拟 configService.applyUserPermissionRules 把 settings.permissions.deny
    // 写入 PolicyEngine 的过程
    getPolicyEngine().loadUserRules({
      deny: ['Bash(rm -rf *)', 'Write(/etc/*)'],
    });

    const decision = getGuardFabric().evaluate({
      tool: 'Bash',
      args: { command: 'rm -rf /tmp/test' },
      topology: 'main', // subagent 走 spawn_agent 路径，topology 也是 main
    });

    expect(decision.verdict).toBe('deny');
    expect(decision.source).toBe('user-config');
    expect(decision.reason).toMatch(/user-config/);
  });

  it('正向：subagent topology=main 时 user deny Write(/etc/*) 命中（继承传递）', () => {
    getPolicyEngine().loadUserRules({
      deny: ['Write(/etc/*)'],
    });

    // 注：传一个安全的 command 避开 PolicyEngine 内置 block-rm-rf-root 规则
    // 的 false-match —— 该 built-in 规则 matcher.commandPattern 在 request.command
    // 缺失时 short-circuit 放行（pre-existing PolicyEngine 行为，本 PR scope 不修），
    // 会导致 non-overridable deny 抢在 user-config 之前命中。
    const decision = getGuardFabric().evaluate({
      tool: 'Write',
      args: { file_path: '/etc/passwd', command: 'noop' },
      topology: 'main',
    });

    expect(decision.verdict).toBe('deny');
    expect(decision.source).toBe('user-config');
    expect(decision.reason).toMatch(/Write\(\/etc\/\*\)/);
  });

  it('反向：user deny Bash(rm -rf *) 不影响 ls -la（精确匹配）', () => {
    getPolicyEngine().loadUserRules({
      deny: ['Bash(rm -rf *)'],
    });

    const decision = getGuardFabric().evaluate({
      tool: 'Bash',
      args: { command: 'ls -la' },
      topology: 'main',
    });

    // ls -la 不匹配 rm -rf *，user-config 不命中
    if (decision.verdict === 'deny') {
      expect(decision.source).not.toBe('user-config');
    } else {
      // 通常会落到 modeAction='prompt' → verdict='ask'
      expect(decision.verdict).not.toBe('deny');
    }
  });

  it('反向：subagent buildChildContext 也把父级 user deny 并集到自己', () => {
    // 模拟 spawnAgent 入口：父 ParentContext.deny 由 configService 暴露
    const parent = makeParent({
      deny: ['Bash(rm -rf *)'],
    });
    const child = {
      agentType: 'explorer',
      allowedTools: ['Read', 'Grep', 'Bash'],
    };
    const ctx = buildChildContext(child, parent, { inheritance: 'strict-inherit' });
    expect(ctx.permissions.deny).toContain('Bash(rm -rf *)');
  });
});

// ============================================================================
// AC-3 / 场景 C: CI preset deny 集合继承到 subagent
// ============================================================================

describe('AC-3 (场景 C): CI 模式主 agent 的 deny/blockedCommands 自动继承到 subagent', () => {
  it('正向：父 blockedCommands 通过 ParentContext.blockedCommands 透传到子 ChildContext', () => {
    const parent = makeParent({
      permissionMode: 'default',
      availableTools: ['Read', 'Bash', 'WebFetch'],
      // CI preset 把 Network(*) 投影成 blockedCommands
      blockedCommands: ['curl', 'wget', 'nc'],
      deny: ['Network(*)'],
    });
    const child = {
      agentType: 'explorer',
      allowedTools: ['Read', 'Bash', 'WebFetch'],
    };
    const ctx = buildChildContext(child, parent, { inheritance: 'strict-inherit' });

    expect(ctx.permissions.blockedCommands).toEqual(['curl', 'wget', 'nc']);
    expect(ctx.permissions.deny).toContain('Network(*)');
  });

  it('正向：CI 把 WebFetch 加入 user deny → GuardFabric 命中 user-config', () => {
    // CI preset 实际实现把 Network(*) 等转译成具体 user rule；
    // 这里直接以 WebFetch 名作为 user rule，验证级联生效。
    // 同样传 command='noop' 避开 PolicyEngine 内置 block-rm-rf-root false-match。
    getPolicyEngine().loadUserRules({ deny: ['WebFetch'] });
    const decision = getGuardFabric().evaluate({
      tool: 'WebFetch',
      args: { url: 'https://example.com', command: 'noop' },
      topology: 'main',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.source).toBe('user-config');
  });

  it('反向：非 CI 模式（无 deny 规则）调 WebFetch 不会被 user-config deny', () => {
    // 不加载任何 deny 规则
    const decision = getGuardFabric().evaluate({
      tool: 'WebFetch',
      args: { url: 'https://example.com' },
      topology: 'main',
    });
    // 不论最终是 allow 还是 ask，都不能是 user-config 来源的 deny
    if (decision.verdict === 'deny') {
      expect(decision.source).not.toBe('user-config');
    }
  });
});

// ============================================================================
// AC-4 / 场景 D: reviewer 禁止 spawn writer
// ============================================================================

describe('AC-4 (场景 D): reviewer/readonly 父禁止 spawn writer 子', () => {
  it('正向：reviewer 父 spawn coder 子 → checkReadonlyParentRule 拒绝', () => {
    const r = checkReadonlyParentRule('reviewer', 'coder', []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/readonly parent role.*cannot spawn writer child role.*coder/);
  });

  it('正向：reviewer 父 spawn fixer/refactorer/debugger 全部拒绝', () => {
    expect(checkReadonlyParentRule('reviewer', 'fixer', []).allowed).toBe(false);
    expect(checkReadonlyParentRule('reviewer', 'refactorer', []).allowed).toBe(false);
    expect(checkReadonlyParentRule('reviewer', 'debugger', []).allowed).toBe(false);
  });

  it('正向：plan 父禁止 spawn 带 write capability 的子（即使 child role 是中性 general）', () => {
    const r = checkReadonlyParentRule('plan', 'general', ['write']);
    expect(r.allowed).toBe(false);
  });

  it('反向：reviewer 父 spawn explorer 子（readonly → readonly）允许通过', () => {
    const r = checkReadonlyParentRule('reviewer', 'explorer', []);
    expect(r.allowed).toBe(true);
  });

  it('反向：coder/default 父 spawn coder 子（writer → writer）允许', () => {
    expect(checkReadonlyParentRule('coder', 'fixer', ['write']).allowed).toBe(true);
    expect(checkReadonlyParentRule(undefined, 'coder', ['write']).allowed).toBe(true);
  });

  it('topology hard rule 不受 inheritance 模式影响（不接受 inheritance 参数）', () => {
    // checkReadonlyParentRule 在 spawnAgent.ts 入口先跑，independent 模式
    // 也会被拦下（plan §4.7：hard topology rule，settings 关不掉）。
    const r1 = checkReadonlyParentRule('reviewer', 'coder', []);
    const r2 = checkReadonlyParentRule('reviewer', 'coder', []);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
  });
});

// ============================================================================
// AC-5: 无 parentContext 的旧 caller fallback 不破坏
// ============================================================================

describe('AC-5: 旧 caller fallback（无显式 parentContext）行为不破坏', () => {
  it('buildParentContextFromToolContext 在 ctx 完全空时返回安全默认', () => {
    // 模拟旧 caller 直接调 getSubagentExecutor().execute(...)，ctx 上没有
    // parent* 字段。subagentExecutor.ts L487 的 auto-derive 路径会跑到这里。
    const ctx = {} as Parameters<typeof buildParentContextFromToolContext>[0];
    const parent = buildParentContextFromToolContext(ctx);

    expect(parent.permissionMode).toBe('default'); // 安全默认
    expect(parent.availableTools).toEqual([]);
    expect(parent.deny).toEqual([]);
    expect(parent.rules).toEqual([]);
  });

  it('buildChildContext 在 parent.availableTools 为空时返回 toolPool=[]（subagentExecutor 会退化）', () => {
    // subagentExecutor.ts L524-528 显式判断：parentTools 为 0 时退化为 child 全集，
    // 避免老 caller 拿不到任何工具。这里只验证 buildChildContext 的输出，
    // 由 caller 决定 fallback 策略。
    const parent = makeParent({ availableTools: [] });
    const child = {
      agentType: 'coder',
      allowedTools: ['Read', 'Bash', 'Write'],
    };
    const ctx = buildChildContext(child, parent, { inheritance: 'strict-inherit' });
    expect(ctx.toolPool).toEqual([]); // 严格交集 = [] (无父工具)
  });

  it('旧 caller 没传 parentRules → buildParentContextFromToolContext 返回空 rules', () => {
    const ctx = { agentRole: 'coder' } as Parameters<typeof buildParentContextFromToolContext>[0];
    const parent = buildParentContextFromToolContext(ctx, {
      permissionMode: 'default',
      availableTools: ['Read', 'Write'],
    });
    // overrides 生效，未显式传的 parent.rules 维持空数组
    expect(parent.rules).toEqual([]);
    expect(parent.permissionMode).toBe('default');
    expect(parent.availableTools).toEqual(['Read', 'Write']);
    expect(parent.role).toBe('coder');
  });
});

// ============================================================================
// AC-6: 合并算法（集成视角再跑一次）
// ============================================================================

describe('AC-6: 合并算法 — tools ∩ / deny ∪ / mode 取严（集成视角）', () => {
  it('正向（tools 交集）：父 readonly 子 declared Bash → toolPool 不含 Bash', () => {
    const parent = makeParent({ availableTools: ['Read', 'Grep'] });
    const child = {
      agentType: 'coder',
      allowedTools: ['Read', 'Grep', 'Bash', 'Write'],
    };
    const ctx = buildChildContext(child, parent);
    expect(ctx.toolPool).toEqual(['Read', 'Grep']);
  });

  it('反向（tools 交集）：父全集 子 declared 子集 → toolPool = 子 declared', () => {
    const parent = makeParent({ availableTools: ['Read', 'Grep', 'Bash', 'Write'] });
    const child = {
      agentType: 'explorer',
      allowedTools: ['Read', 'Grep'],
    };
    const ctx = buildChildContext(child, parent);
    expect(ctx.toolPool).toEqual(['Read', 'Grep']);
  });

  it('正向（deny 并集）：父 deny ∪ 子 deny', () => {
    const parent = makeParent({ deny: ['Bash(rm -rf *)'] });
    const child = {
      agentType: 'coder',
      allowedTools: ['Bash'],
      deny: ['Write(/etc/*)'],
    };
    const ctx = buildChildContext(child, parent);
    expect(ctx.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(rm -rf *)', 'Write(/etc/*)']),
    );
  });

  it('反向（deny 并集）：父 deny 为空时子 deny 单独生效', () => {
    const parent = makeParent({ deny: [] });
    const child = {
      agentType: 'coder',
      allowedTools: ['Bash'],
      deny: ['Bash(rm -rf *)'],
    };
    const ctx = buildChildContext(child, parent);
    expect(ctx.permissions.deny).toEqual(['Bash(rm -rf *)']);
  });

  it('正向（mode 取严）：父 plan + 子 normal → effectiveMode=plan', () => {
    const parent = makeParent({ permissionMode: 'plan' });
    const child = { agentType: 'general', allowedTools: ['Read'], mode: 'normal' };
    const ctx = buildChildContext(child, parent);
    expect(ctx.permissions.effectiveMode).toBe('plan');
  });

  it('反向（mode 取严）：父 acceptEdits + 子 normal → effectiveMode=normal（mode 字符串走自定义 ranking）', () => {
    // childContext.ts 的 MODE_RESTRICTIVENESS 表里 'normal' 走 fallback=2,
    // 'acceptEdits'=1。所以子 normal 比父 acceptEdits 严，effectiveMode=normal。
    const parent = makeParent({ permissionMode: 'acceptEdits' });
    const child = { agentType: 'general', allowedTools: ['Read'], mode: 'normal' };
    const ctx = buildChildContext(child, parent);
    expect(ctx.permissions.effectiveMode).toBe('normal');
  });

  it('反向（mode 取严）：父 bypassPermissions + 子 plan → effectiveMode=plan（子严父宽时取子）', () => {
    const parent = makeParent({ permissionMode: 'bypassPermissions' });
    const child = { agentType: 'general', allowedTools: ['Read'], mode: 'plan' };
    const ctx = buildChildContext(child, parent);
    expect(ctx.permissions.effectiveMode).toBe('plan');
  });
});
