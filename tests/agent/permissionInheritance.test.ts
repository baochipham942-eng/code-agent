// ============================================================================
// permissionInheritance.test.ts
//
// 验证 plan §4.4 合并算法（plan §2 AC-6）：
//   1) tools = parent ∩ child
//   2) deny = parent ∪ child
//   3) mode 取更严
// 以及 §4.7 readonly→writer 黑名单（AC-4 准备工作）。
// ============================================================================

import { describe, it, expect, vi, beforeAll } from 'vitest';

// 把 prompts/builder mock 掉，避免单测引入 soul / 真实配置依赖
vi.mock('../../src/host/prompts/builder', () => ({
  buildProfilePrompt: vi.fn(() => 'mocked-prompt'),
}));

import {
  buildChildContext,
  checkReadonlyParentRule,
  DEFAULT_INHERITANCE_MODE,
  type ParentContext,
  type ChildContextConfig,
} from '../../src/host/agent/childContext';

beforeAll(() => {
  // 静默单测里的 logger 输出
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function baseParent(overrides: Partial<ParentContext> = {}): ParentContext {
  return {
    rules: [],
    memory: [],
    hooks: [],
    skills: [],
    mcpConnections: [],
    permissionMode: 'default',
    availableTools: ['read', 'grep', 'bash', 'write'],
    deny: [],
    ask: [],
    allow: [],
    ...overrides,
  };
}

function baseChild(overrides: Partial<ChildContextConfig> = {}): ChildContextConfig {
  return {
    agentType: 'coder',
    allowedTools: ['read', 'grep', 'bash', 'write'],
    ...overrides,
  };
}

describe('buildChildContext — plan §4.4 merge algorithm', () => {
  it('AC-6.1: toolPool = parent.availableTools ∩ child.allowedTools (永不扩张)', () => {
    const parent = baseParent({ availableTools: ['read', 'grep'] });
    const child = baseChild({ allowedTools: ['read', 'grep', 'bash', 'write'] });
    const result = buildChildContext(child, parent);
    expect(result.toolPool).toEqual(['read', 'grep']);
    expect(result.toolPool).not.toContain('bash');
    expect(result.toolPool).not.toContain('write');
  });

  it('AC-6.1: 即使 child 声明更宽工具集，交集后只保留父允许的', () => {
    const parent = baseParent({ availableTools: ['read'] });
    const child = baseChild({ allowedTools: ['read', 'write', 'bash', 'edit'] });
    const result = buildChildContext(child, parent);
    expect(result.toolPool).toEqual(['read']);
  });

  it('AC-6.2: deny = parent.deny ∪ child.deny (永远叠加)', () => {
    const parent = baseParent({ deny: ['Bash(rm -rf *)', 'Network(*)'] });
    const child = baseChild({ deny: ['Write(/etc/*)'] });
    const result = buildChildContext(child, parent);
    expect(result.permissions.deny).toEqual(expect.arrayContaining([
      'Bash(rm -rf *)',
      'Network(*)',
      'Write(/etc/*)',
    ]));
    expect(result.permissions.deny).toHaveLength(3);
  });

  it('AC-6.2: deny 去重正确', () => {
    const parent = baseParent({ deny: ['Bash(rm *)'] });
    const child = baseChild({ deny: ['Bash(rm *)', 'Write(/etc/*)'] });
    const result = buildChildContext(child, parent);
    expect(result.permissions.deny).toHaveLength(2);
  });

  it('AC-6.3: mode 取更严 — plan > default', () => {
    const parent = baseParent({ permissionMode: 'plan' });
    const child = baseChild({ mode: 'default' });
    const result = buildChildContext(child, parent);
    expect(result.permissions.effectiveMode).toBe('plan');
  });

  it('AC-6.3: mode 取更严 — default > acceptEdits', () => {
    const parent = baseParent({ permissionMode: 'acceptEdits' });
    const child = baseChild({ mode: 'default' });
    const result = buildChildContext(child, parent);
    expect(result.permissions.effectiveMode).toBe('default');
  });

  it('AC-6.3: mode 取更严 — bypassPermissions 最宽松，永远被覆盖', () => {
    const parent = baseParent({ permissionMode: 'bypassPermissions' });
    const child = baseChild({ mode: 'plan' });
    const result = buildChildContext(child, parent);
    expect(result.permissions.effectiveMode).toBe('plan');
  });
});

describe('buildChildContext — inheritance modes', () => {
  it('默认 inheritance mode 是 strict-inherit', () => {
    const result = buildChildContext(baseChild(), baseParent());
    expect(result.inheritanceMode).toBe('strict-inherit');
    expect(DEFAULT_INHERITANCE_MODE).toBe('strict-inherit');
  });

  it('strict-inherit: 子的 ask/allow 必须是父的子集', () => {
    const parent = baseParent({
      ask: ['Bash(ls *)'],
      allow: ['Read(*)'],
    });
    const child = baseChild({
      ask: ['Bash(ls *)', 'Network(*)'],  // 超出父集合的 Network 会被裁掉
      allow: ['Read(*)', 'Write(*)'],     // 超出父集合的 Write 会被裁掉
    });
    const result = buildChildContext(child, parent, { inheritance: 'strict-inherit' });
    expect(result.permissions.ask).toEqual(['Bash(ls *)']);
    expect(result.permissions.allow).toEqual(['Read(*)']);
  });

  it('child-narrow: 父 mode default 时允许子在父 (ask ∪ allow) 范围内自行扩 allow', () => {
    const parent = baseParent({
      permissionMode: 'default',
      ask: ['Bash(ls *)'],
      allow: ['Read(*)'],
    });
    const child = baseChild({
      // 子可以把父的 ask 提升到自己 allow
      allow: ['Read(*)', 'Bash(ls *)'],
    });
    const result = buildChildContext(child, parent, { inheritance: 'child-narrow' });
    expect(result.permissions.allow).toEqual(expect.arrayContaining(['Read(*)', 'Bash(ls *)']));
  });

  it('child-narrow: 父 mode plan 时退化为 strict-inherit 语义（不让子放宽）', () => {
    const parent = baseParent({
      permissionMode: 'plan',
      ask: ['Bash(ls *)'],
      allow: ['Read(*)'],
    });
    const child = baseChild({
      allow: ['Read(*)', 'Bash(ls *)'],
    });
    const result = buildChildContext(child, parent, { inheritance: 'child-narrow' });
    // Bash(ls *) 不在父 allow 里，所以应被裁掉
    expect(result.permissions.allow).toEqual(['Read(*)']);
  });

  it('independent: 子自己决定 ask/allow（不取父交集），但 deny 仍然并集', () => {
    const parent = baseParent({
      deny: ['Network(*)'],
      ask: ['Bash(ls *)'],
      allow: ['Read(*)'],
    });
    const child = baseChild({
      ask: ['Custom(*)'],
      allow: ['Write(*)'],
      deny: ['Bash(rm *)'],
    });
    const result = buildChildContext(child, parent, { inheritance: 'independent' });
    // ask/allow 完全用子的
    expect(result.permissions.ask).toEqual(['Custom(*)']);
    expect(result.permissions.allow).toEqual(['Write(*)']);
    // deny 仍然并集
    expect(result.permissions.deny).toEqual(expect.arrayContaining(['Network(*)', 'Bash(rm *)']));
  });

  it('tools 交集和 deny 并集对所有三档都生效（永不扩张）', () => {
    for (const mode of ['strict-inherit', 'child-narrow', 'independent'] as const) {
      const parent = baseParent({
        availableTools: ['read'],
        deny: ['Net(*)'],
      });
      const child = baseChild({
        allowedTools: ['read', 'write', 'bash'],
        deny: ['Bash(rm *)'],
      });
      const result = buildChildContext(child, parent, { inheritance: mode });
      expect(result.toolPool).toEqual(['read']);
      expect(result.permissions.deny).toEqual(expect.arrayContaining(['Net(*)', 'Bash(rm *)']));
    }
  });
});

describe('checkReadonlyParentRule — plan §4.7 / AC-4 场景 D', () => {
  it('reviewer 父禁止 spawn coder 子', () => {
    const r = checkReadonlyParentRule('reviewer', 'coder', []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cannot spawn writer child role/);
  });

  it('reviewer 父允许 spawn explorer 子（readonly→readonly OK）', () => {
    const r = checkReadonlyParentRule('reviewer', 'explorer', []);
    expect(r.allowed).toBe(true);
  });

  it('plan 父禁止 spawn 带 write capability 的子', () => {
    const r = checkReadonlyParentRule('plan', 'general', ['write']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cannot spawn child with 'write' capability/);
  });

  it('plan 父禁止 spawn 带 code_execution capability 的子', () => {
    const r = checkReadonlyParentRule('plan', 'general', ['code_execution']);
    expect(r.allowed).toBe(false);
  });

  it('coder 父（非 readonly）允许 spawn 任意子（topology hard rule 不约束）', () => {
    const r = checkReadonlyParentRule('coder', 'fixer', ['write']);
    expect(r.allowed).toBe(true);
  });

  it('父 role 缺失时直接放行（向后兼容老 caller）', () => {
    const r = checkReadonlyParentRule(undefined, 'coder', ['write']);
    expect(r.allowed).toBe(true);
  });

  it('role 名大小写不敏感', () => {
    const r = checkReadonlyParentRule('Reviewer', 'CODER', []);
    expect(r.allowed).toBe(false);
  });
});
