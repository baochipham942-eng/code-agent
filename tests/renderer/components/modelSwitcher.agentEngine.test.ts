import { describe, expect, it } from 'vitest';
import type { AgentEngineDescriptor } from '../../../src/shared/contract/agentEngine';
import { buildModelSwitcherEngineSelection } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

function descriptor(overrides: Partial<AgentEngineDescriptor>): AgentEngineDescriptor {
  return {
    kind: 'native',
    label: 'Agent Neo',
    summary: '',
    installState: 'builtin',
    runtimeState: 'ready',
    executable: true,
    capabilities: ['execute'],
    defaultPermissionProfile: 'default',
    cwdPolicy: 'workspace_only',
    riskTier: 'low',
    detectedAt: 1,
    ...overrides,
  };
}

describe('ModelSwitcher Agent Engine selection', () => {
  it('builds a session-scoped engine selection without model provider fields', () => {
    const selection = buildModelSwitcherEngineSelection(descriptor({
      kind: 'codex_cli',
      label: 'Codex CLI',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }));

    expect(selection).toEqual({
      kind: 'codex_cli',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
    expect(selection).not.toHaveProperty('provider');
    expect(selection).not.toHaveProperty('model');
  });

  it('keeps Claude Code selection on the same session metadata contract', () => {
    expect(buildModelSwitcherEngineSelection(descriptor({
      kind: 'claude_code',
      label: 'Claude Code',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }))).toEqual({
      kind: 'claude_code',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('carries the current workspace as cwd for external engines', () => {
    expect(buildModelSwitcherEngineSelection(descriptor({
      kind: 'codex_cli',
      label: 'Codex CLI',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }), '/repo/code-agent')).toEqual({
      kind: 'codex_cli',
      cwd: '/repo/code-agent',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('carries the catalog model separately from provider model overrides', () => {
    expect(buildModelSwitcherEngineSelection(descriptor({
      kind: 'claude_code',
      label: 'Claude Code',
      installState: 'installed',
      defaultPermissionProfile: 'read_only',
      riskTier: 'medium',
    }), '/repo/code-agent', 'sonnet')).toEqual({
      kind: 'claude_code',
      cwd: '/repo/code-agent',
      model: 'sonnet',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });
});
