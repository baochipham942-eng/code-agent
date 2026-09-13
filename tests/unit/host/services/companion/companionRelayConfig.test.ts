import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCompanionRelayIfConfigured } from '../../../../../src/host/services/companion/CompanionRelayClient';
import { loadCompanionRelayConfig } from '../../../../../src/host/services/companion/companionRelayConfig';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';

const gateway = {} as CompanionGateway;

describe('companion relay config', () => {
  it('is inert when the config file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    expect(loadCompanionRelayConfig(dir)).toBeNull();
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error('should not load identity'); },
    })).resolves.toBeNull();
  });

  it('is inert when enabled is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    await writeFile(join(dir, L.relayConfigFile), JSON.stringify({
      v: 1, enabled: false, url: 'wss://relay.example.invalid/companion', credentialRef: 'companion-relay',
    }));
    expect(loadCompanionRelayConfig(dir)).toBeNull();
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error('should not load identity'); },
    })).resolves.toBeNull();
  });

  it('is inert when enabled but the credential cannot be resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    await writeFile(join(dir, L.relayConfigFile), JSON.stringify({
      v: 1, enabled: true, url: 'wss://relay.example.invalid/companion', credentialRef: 'companion-relay',
    }));
    expect(loadCompanionRelayConfig(dir)).toMatchObject({ credentialRef: 'companion-relay' });
    await expect(startCompanionRelayIfConfigured({
      dataDirectory: dir,
      gateway,
      loadIdentity: async () => { throw new Error('should not load identity'); },
    })).resolves.toBeNull();
  });

  it('treats malformed config as disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-relay-'));
    await writeFile(join(dir, L.relayConfigFile), '{not json');
    expect(loadCompanionRelayConfig(dir)).toBeNull();
  });
});
