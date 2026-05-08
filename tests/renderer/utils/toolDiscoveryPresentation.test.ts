import { describe, expect, it } from 'vitest';
import type { ToolCapabilityView } from '../../../src/renderer/types/runWorkbench';
import { buildToolDiscoveryGroups } from '../../../src/renderer/utils/toolDiscoveryPresentation';

function tool(overrides: Partial<ToolCapabilityView> & Pick<ToolCapabilityView, 'id' | 'callable'>): ToolCapabilityView {
  return {
    label: overrides.id,
    source: 'builtin',
    permissionLevel: 'unknown',
    activatedForTurn: true,
    ...overrides,
  };
}

describe('toolDiscoveryPresentation', () => {
  it('groups callable, authorization, blocked, and activated tools', () => {
    const groups = buildToolDiscoveryGroups([
      tool({ id: 'read', callable: true }),
      tool({ id: 'gmail', callable: false, blockedReason: '需要授权 Gmail' }),
      tool({ id: 'custom', callable: false, blockedReason: 'not installed' }),
      tool({ id: 'old', callable: true, activatedForTurn: false }),
    ]);

    expect(groups.find((group) => group.key === 'callable')?.tools.map((item) => item.id)).toEqual(['read', 'old']);
    expect(groups.find((group) => group.key === 'needsAuthorization')?.tools.map((item) => item.id)).toEqual(['gmail']);
    expect(groups.find((group) => group.key === 'blocked')?.tools.map((item) => item.id)).toEqual(['custom']);
    expect(groups.find((group) => group.key === 'activatedForTurn')?.tools.map((item) => item.id)).toEqual(['read', 'gmail', 'custom']);
  });
});
