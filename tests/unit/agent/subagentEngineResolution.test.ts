import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSubagentEngine: vi.fn() }));

vi.mock('../../../src/host/agent/agentDefinition', () => ({
  getSubagentEngine: (...args: unknown[]) => mocks.getSubagentEngine(...args),
}));

import { resolveSubagentEngine } from '../../../src/host/agent/subagentEngineResolution';

const baseConfig = {
  name: 'expert',
  roleId: 'expert-role',
  systemPrompt: 'system',
  availableTools: [],
};

describe('subagent engine resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the spawn override before role equipment', () => {
    mocks.getSubagentEngine.mockReturnValue('claude_code');
    expect(resolveSubagentEngine({ ...baseConfig, engine: 'codex_cli' })).toBe('codex_cli');
  });

  it('uses role equipment when no spawn override is present', () => {
    mocks.getSubagentEngine.mockReturnValue('claude_code');
    expect(resolveSubagentEngine(baseConfig)).toBe('claude_code');
  });

  it('keeps the native route when neither source selects an engine', () => {
    mocks.getSubagentEngine.mockReturnValue(undefined);
    expect(resolveSubagentEngine(baseConfig)).toBe('native');
  });
});
