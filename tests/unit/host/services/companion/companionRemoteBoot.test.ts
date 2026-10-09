import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const harness = vi.hoisted(() => ({
  db: null as Database.Database | null,
  legacyStarts: 0,
  accountStarts: 0,
}));

vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => harness.db,
    getSession: (id: string) => ({ id, title: id, workingDirectory: '/tmp/companion-boot', projectId: null }),
    getProjectRepo: () => ({ getProject: () => null, listProjects: () => [] }),
  }),
}));

vi.mock('../../../../../src/host/services/companion/CompanionRelayClient', () => ({
  startCompanionRelayIfConfigured: async () => {
    harness.legacyStarts += 1;
    return null;
  },
}));

vi.mock('../../../../../src/host/services/companion/companionRelayAccount', () => ({
  startCompanionRelayAccountIfConfigured: () => {
    harness.accountStarts += 1;
    return {
      stop: async () => {},
      suspend: async () => {},
      resume: () => {},
      revoke: () => {},
      status: () => ({ account: 'off' as const }),
      relayRoute: () => null,
      respondPair: () => false,
      connected: () => false,
      dialing: () => false,
    };
  },
}));

vi.mock('../../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => null,
    getAccessToken: async () => null,
    addAuthChangeCallback: () => () => {},
  }),
}));

import { createApp, type CreateAppDeps } from '../../../../../src/web/app';
import { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';
import { RunRegistry } from '../../../../../src/host/runtime/runRegistry';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../../../src/shared/companion/lanProtocol';

function deps(dataDir: string, info: string[], stop: { current?: () => Promise<void> }): CreateAppDeps {
  return {
    handlers: new Map(),
    logger: { info: message => { info.push(String(message)); }, warn: () => {}, error: () => {} },
    runRegistry: new RunRegistry(),
    pendingLocalToolCalls: new Map(),
    pendingDevPermissions: new Map(),
    resolveCodeAgentDataDir: () => dataDir,
    getAppVersion: () => '0.0.0-test',
    getBuildInfo: () => null,
    getDurableRunRollout: () => ({
      policy: { mode: 'legacy', configuredValue: null, valid: true, durableActivation: false, durableReadPreference: false },
      ready: false,
    }),
    getDurableRunReadService: () => undefined,
    internalFeatures: {
      runtime: { isLoaded: () => false, loadedHash: () => undefined },
      registry: { getPlugin: () => undefined },
      pluginsDir: path.join(dataDir, 'plugins'),
    },
    registerCompanionShutdown: fn => { stop.current = fn; },
  };
}

describe('createApp honours the persisted remote switch', () => {
  let dataDir: string;
  let db: Database.Database;
  let stop: { current?: () => Promise<void> };

  afterEach(async () => {
    await stop?.current?.();
    db?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    harness.db = null;
  });

  function boot(off: boolean): string[] {
    harness.legacyStarts = 0;
    harness.accountStarts = 0;
    dataDir = mkdtempSync(path.join(tmpdir(), 'killswitch-boot-'));
    db = new Database(':memory:');
    const gateway = new CompanionGateway(db);
    gateway.pairIdentity(toHex(createIdentity().publicKey), ['shared']);
    if (off) gateway.setRemoteEnabled(false);
    harness.db = db;
    stop = {};
    const info: string[] = [];
    createApp(deps(dataDir, info, stop));
    return info;
  }

  it('starts both relay factories when the settings row is absent', () => {
    const info = boot(false);
    expect(harness.legacyStarts).toBe(1);
    expect(harness.accountStarts).toBe(1);
    expect(info.join('\n')).not.toContain('Companion remote access is off');
  });

  it('does not start LAN or either relay factory when the saved flag is off', () => {
    const info = boot(true);
    expect(harness.legacyStarts).toBe(0);
    expect(harness.accountStarts).toBe(0);
    expect(info).toContain('Companion remote access is off; LAN listener and relay sockets stay down');
  });
});
