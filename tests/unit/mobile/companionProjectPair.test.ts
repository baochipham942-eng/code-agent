import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore, defaultCompanionSessionCreate, needsLibraryPick } from '../../../packages/mobile/src/stores/companionStore';

const harness = vi.hoisted(() => ({ scope: ['project:one'] as string[] }));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() {
      return {
        version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
        deviceId: 'phone-1', scopeEpoch: 1, scope: harness.scope,
      };
    }
    async recover(_target: unknown, existing?: { scope: string[] }) {
      return existing ?? {
        version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
        deviceId: 'phone-1', scopeEpoch: 1, scope: harness.scope,
      };
    }
    async request() { return { kind: 'events', epoch: 1, nextSeq: 0, events: [] }; }
    close() {}
  },
}));

function invitation() {
  return JSON.stringify({
    version: 1, endpoint: 'http://192.168.1.2:8182', inviteId: '123e4567-e89b-12d3-a456-426614174000',
    psk: 'aa'.repeat(32), hostKey: 'bb'.repeat(32), expiresAt: Date.now() + 60_000,
  });
}

afterEach(() => { harness.scope = ['project:one']; });

describe('project-only companion pairing', () => {
  it('does not pin a conversation when the grant is only projects', async () => {
    const store = createCompanionStore({
      read: async () => null, write: async () => {}, scan: async () => invitation(), post: async () => ({}),
    }, () => {});
    await store.getState().pair();
    expect(store.getState().status).toBe('connected');
    expect(store.getState().sessionId).toBeNull();
    expect(needsLibraryPick(store.getState())).toBe(true);
  });

  it('pairs from a provided invitation payload without scanning again', async () => {
    let scans = 0;
    const store = createCompanionStore({
      read: async () => null, write: async () => {},
      scan: async () => { scans++; return invitation(); },
      post: async () => ({}),
    }, () => {});
    await store.getState().pair(invitation());
    expect(scans).toBe(0);
    expect(store.getState().status).toBe('connected');
  });

  it('still pins an old session grant so a narrow device keeps its conversation', async () => {
    harness.scope = ['session-1'];
    const identity = createIdentity();
    const store = createCompanionStore({
      read: async () => JSON.stringify({
        version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
        binding: {
          version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey),
          deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'],
        },
      }),
      write: async () => {}, scan: async () => invitation(), post: async () => ({}),
    }, () => {});
    await store.getState().hydrate();
    expect(store.getState().sessionId).toBe('session-1');
    expect(needsLibraryPick(store.getState())).toBe(false);
  });
});

describe('defaultCompanionSessionCreate', () => {
  it('picks a creatable project and the computer default model', () => {
    expect(defaultCompanionSessionCreate({
      nextOffset: null,
      projects: [
        { id: 'blocked', name: 'Blocked', canCreate: false },
        { id: 'ok', name: 'Ok', canCreate: true },
      ],
      sessions: [],
      models: [
        { provider: 'moonshot', model: 'kimi-k2.6', label: 'Kimi', providerLabel: 'Kimi' },
        { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek', providerLabel: 'DeepSeek', isDefault: true },
      ],
    })).toEqual({ projectId: 'ok', provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('returns null when nothing can be created', () => {
    expect(defaultCompanionSessionCreate(null)).toBeNull();
    expect(defaultCompanionSessionCreate({
      nextOffset: null, projects: [{ id: 'blocked', name: 'Blocked', canCreate: false }],
      sessions: [], models: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek', providerLabel: 'DeepSeek' }],
    })).toBeNull();
  });
});
