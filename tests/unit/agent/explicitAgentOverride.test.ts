// ============================================================================
// resolveExplicitAgentOverride — web /api/run 路径的显式 agent 覆盖解析
// （P0：此前该路径完全丢弃 preferredAgentId，/agent 选择在生产 web 路径是 no-op）
// ============================================================================

import { describe, expect, it } from 'vitest';
import { resolveExplicitAgentOverride } from '../../../src/host/agent/explicitAgentOverride';
import { READONLY_TOOL_DENYLIST } from '../../../src/host/agent/routingToolPolicy';

describe('resolveExplicitAgentOverride', () => {
  it('explore（readonly）→ 换 prompt + 拒写工具 denylist', () => {
    const override = resolveExplicitAgentOverride('explore');
    expect(override).not.toBeNull();
    expect(override!.id).toBe('explore');
    expect(override!.systemPrompt.length).toBeGreaterThan(50);
    expect(new Set(override!.deniedToolNames)).toEqual(new Set(READONLY_TOOL_DENYLIST));
  });

  it('coder（非 readonly）→ 换 prompt 但不加工具约束', () => {
    const override = resolveExplicitAgentOverride('coder');
    expect(override).not.toBeNull();
    expect(override!.deniedToolNames).toEqual([]);
    const explorePrompt = resolveExplicitAgentOverride('explore')!.systemPrompt;
    expect(override!.systemPrompt === explorePrompt).toBe(false);
  });

  it('未知 id / 空值 → null（回退自动路由，不炸 run）', () => {
    expect(resolveExplicitAgentOverride('no-such-agent')).toBeNull();
    expect(resolveExplicitAgentOverride(undefined)).toBeNull();
    expect(resolveExplicitAgentOverride(null)).toBeNull();
    expect(resolveExplicitAgentOverride('')).toBeNull();
  });
});
