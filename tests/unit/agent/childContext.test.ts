// ============================================================================
// childContext.test.ts — Unit tests for buildChildContext
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { buildChildContext, type ParentContext, type ChildContextConfig } from '../../../src/main/agent/childContext';

// Mock buildProfilePrompt to avoid heavy prompt-building side-effects
vi.mock('../../../src/main/prompts/builder', () => ({
  buildProfilePrompt: vi.fn((profile: string, ctx: Record<string, unknown>) => {
    return `[profile:${profile}] rules=${JSON.stringify(ctx.rules)} memory=${JSON.stringify(ctx.memory)} mode=${ctx.mode ?? ''}`;
  }),
}));

const baseParent: ParentContext = {
  rules: ['rule1', 'rule2', 'rule3', 'rule4', 'rule5'],
  memory: ['mem1', 'mem2', 'mem3', 'mem4', 'mem5', 'mem6', 'mem7'],
  hooks: [{ id: 'hook1' }],
  skills: ['skill1', 'skill2'],
  mcpConnections: [{ server: 'mcp1' }],
  permissionMode: 'default',
  availableTools: ['read', 'write', 'bash', 'glob', 'grep', 'web_search'],
};

const baseConfig: ChildContextConfig = {
  agentType: 'test-agent',
  allowedTools: ['read', 'glob'],
};

describe('buildChildContext', () => {
  it('produces subagent profile prompt', () => {
    const ctx = buildChildContext(baseConfig, baseParent);
    expect(ctx.prompt).toContain('profile:subagent');
  });

  it('filters tool pool to intersection of allowed and parent', () => {
    const ctx = buildChildContext({ ...baseConfig, allowedTools: ['read', 'glob', 'bash'] }, baseParent);
    expect(ctx.toolPool).toEqual(expect.arrayContaining(['read', 'glob', 'bash']));
    expect(ctx.toolPool).toHaveLength(3);
  });

  it('child cannot have tools parent does not have', () => {
    const ctx = buildChildContext(
      { ...baseConfig, allowedTools: ['read', 'nonexistent_tool'] },
      baseParent
    );
    expect(ctx.toolPool).toEqual(['read']);
    expect(ctx.toolPool).not.toContain('nonexistent_tool');
  });

  it('readOnly=true returns slim memory (last 5)', () => {
    const ctx = buildChildContext({ ...baseConfig, readOnly: true }, baseParent);
    // parent.memory has 7 items; last 5 = mem3..mem7
    expect(ctx.memory).toEqual(['mem3', 'mem4', 'mem5', 'mem6', 'mem7']);
    expect(ctx.memory).toHaveLength(5);
  });

  it('readOnly=true returns slim rules (first 3)', () => {
    const ctx = buildChildContext({ ...baseConfig, readOnly: true }, baseParent);
    expect(ctx.prompt).toContain('"rule1"');
    expect(ctx.prompt).toContain('"rule3"');
    // rule4 and rule5 should NOT appear in the prompt
    expect(ctx.prompt).not.toContain('"rule4"');
    expect(ctx.prompt).not.toContain('"rule5"');
  });

  it('readOnly=false returns full memory', () => {
    const ctx = buildChildContext({ ...baseConfig, readOnly: false }, baseParent);
    expect(ctx.memory).toEqual(baseParent.memory);
    expect(ctx.memory).toHaveLength(7);
  });

  it('inherits bypassPermissions from parent', () => {
    const ctx = buildChildContext(baseConfig, { ...baseParent, permissionMode: 'bypassPermissions' });
    expect(ctx.permissions.inherited).toContain('bypassPermissions');
  });

  it('inherits acceptEdits from parent', () => {
    const ctx = buildChildContext(baseConfig, { ...baseParent, permissionMode: 'acceptEdits' });
    expect(ctx.permissions.inherited).toContain('acceptEdits');
  });

  it('default permission mode inherits nothing', () => {
    const ctx = buildChildContext(baseConfig, { ...baseParent, permissionMode: 'default' });
    expect(ctx.permissions.inherited).toHaveLength(0);
  });

  it('canEscalate is always false', () => {
    const ctxDefault = buildChildContext(baseConfig, baseParent);
    expect(ctxDefault.permissions.canEscalate).toBe(false);

    const ctxBypass = buildChildContext(baseConfig, { ...baseParent, permissionMode: 'bypassPermissions' });
    expect(ctxBypass.permissions.canEscalate).toBe(false);
  });

  it('inherits hooks from parent', () => {
    const ctx = buildChildContext(baseConfig, baseParent);
    expect(ctx.hooks).toEqual(baseParent.hooks);
    // should be a copy, not the same reference
    expect(ctx.hooks).not.toBe(baseParent.hooks);
  });

  it('inherits skills from parent', () => {
    const ctx = buildChildContext(baseConfig, baseParent);
    expect(ctx.skills).toEqual(baseParent.skills);
    expect(ctx.skills).not.toBe(baseParent.skills);
  });

  it('inherits mcpConnections from parent', () => {
    const ctx = buildChildContext(baseConfig, baseParent);
    expect(ctx.mcpConnections).toEqual(baseParent.mcpConnections);
    expect(ctx.mcpConnections).not.toBe(baseParent.mcpConnections);
  });
});
