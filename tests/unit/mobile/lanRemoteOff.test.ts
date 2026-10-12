import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { deriveInvitationVerify, toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-COMPANION-KILLSWITCH-WIRE ⑥：固定的 REMOTE_OFF 403 在 hello、finish、exchange 三条路都
 * 归到 connectionRemoteOff。配对绑定留在盘上，状态是 offline、自动重试继续挂；成功的下一拍
 * 回到 connected。这个测试只打 store 的公共端口，nativeCompanion 的 HTTP body 判读另有源码契约。
 */
const harness = vi.hoisted(() => ({
  recoverError: null as string | null,
  pairError: null as string | null,
  syncError: null as string | null,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() {
      if (harness.pairError) throw new Error(harness.pairError);
      return binding();
    }
    async recover() {
      if (harness.recoverError) throw new Error(harness.recoverError);
      return binding();
    }
    async request(payload: Record<string, unknown>) {
      if (payload.action === 'sync' && harness.syncError) throw new Error(harness.syncError);
      if (payload.action === 'sync') return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
      return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: 'accepted', result: {} } };
    }
    close() {}
  },
}));

const HOST_KEY = 'aa'.repeat(32);
const binding = () => ({ version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: HOST_KEY,
  deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] });

function savedBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({ version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey), binding: binding() });
}

function invitation(): string {
  const psk = 'bb'.repeat(32);
  const inviteId = '00000000-0000-4000-8000-000000000001';
  return JSON.stringify({ version: 1, endpoint: 'http://192.168.1.2:8182', inviteId, psk, hostKey: HOST_KEY,
    expiresAt: Date.now() + 60_000, verify: deriveInvitationVerify(psk, HOST_KEY) });
}

function storeOf() {
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => savedBinding(),
    write: async () => {},
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
  };
  return createCompanionStore(companion, () => {});
}

async function hydratedStore() {
  const store = storeOf();
  await store.getState().hydrate();
  expect(store.getState().status).toBe('connected');
  return store;
}

describe('手机收到 COMPANION_REMOTE_OFF 时保留配对并继续重试', () => {
  beforeEach(() => {
    harness.recoverError = null;
    harness.pairError = null;
    harness.syncError = null;
  });

  it('hello（recover）403 → connectionRemoteOff，成功重试后 connected', async () => {
    harness.recoverError = 'COMPANION_REMOTE_OFF';
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRemoteOff', autoRetrying: true, binding: expect.any(Object) });
    expect(store.getState().status).not.toBe('rejected');
    harness.recoverError = null;
    await store.getState().reconnect({ resetBackoff: true });
    expect(store.getState()).toMatchObject({ status: 'connected', connectionError: null });
  });

  it('finish（pair）403 → connectionRemoteOff，旧 binding 不被清掉', async () => {
    const store = await hydratedStore();
    harness.pairError = 'COMPANION_REMOTE_OFF';
    await store.getState().pair(invitation());
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRemoteOff', autoRetrying: true, binding: expect.any(Object) });
    expect(store.getState().status).not.toBe('rejected');
  });

  it('exchange 403 → connectionRemoteOff，不调用撤销结算；下一次成功回 connected', async () => {
    const store = await hydratedStore();
    harness.syncError = 'COMPANION_REMOTE_OFF';
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRemoteOff', autoRetrying: true, binding: expect.any(Object) });
    expect(store.getState().status).not.toBe('rejected');
    harness.syncError = null;
    await store.getState().reconnect({ resetBackoff: true });
    expect(store.getState()).toMatchObject({ status: 'connected', connectionError: null });
  });
});
