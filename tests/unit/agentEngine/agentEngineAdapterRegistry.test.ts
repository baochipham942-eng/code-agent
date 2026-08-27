import { describe, expect, it } from 'vitest';
import type { ExternalAgentEngineKind } from '../../../src/shared/contract/agentEngine';
import { AgentEngineCapabilityError } from '../../../src/shared/contract/agentEngine';
import { listExternalEngineManifests } from '../../../src/shared/externalEngineManifest';
import { getExternalEngineAdapter } from '../../../src/host/services/agentEngine/agentEngineAdapterRegistry';

describe('external engine adapter registry', () => {
  it('constructs every executable external manifest adapter', () => {
    const executableKinds = listExternalEngineManifests()
      .filter((manifest): manifest is typeof manifest & { kind: ExternalAgentEngineKind } => (
        manifest.kind !== undefined
        && manifest.kind !== 'native'
        && manifest.capabilities.includes('execute')
      ))
      .map((manifest) => manifest.kind);

    // 8 = 7 家 CLI + kimi_code_acp（ACP transport，与 CLI 形态的 kimi_code 并存）。
    expect(executableKinds).toHaveLength(8);
    for (const kind of executableKinds) {
      expect(getExternalEngineAdapter(kind)).toHaveProperty('run');
    }
  });

  it('fails loudly when a manifest adapter id has no registered factory', () => {
    expect(() => getExternalEngineAdapter('unknown_adapter' as ExternalAgentEngineKind))
      .toThrow(AgentEngineCapabilityError);
  });
});
