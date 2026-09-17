import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-DURABLE-WAITING-NO-EXIT 手机侧：run.cancel 收到 alreadyTerminal 结算时必须清 runId
 * 结束「正在处理」。现场是宿主重启后 run 恢复成 waiting 没有 handle——宿主会把它终态化并
 * 按 alreadyTerminal 结算，手机若只认 agent_cancelled 事件就永远停在「正在处理」。
 */
const harness = vi.hoisted(() => ({
  /** 按命令 payload.runId 注入结算结果；没注入的默认走 alreadyTerminal。 */
  resultsByPayloadRunId: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('unused'); }
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
        deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-waiting'] };
    }
    async request(payload: Record<string, unknown>) {
      if (payload.action === 'command') {
        const command = payload.command as { commandId: string; payload: { runId: string } };
        const result = harness.resultsByPayloadRunId.get(command.payload.runId) ?? { alreadyTerminal: true };
        // 结算回执：原样回带命令身份（companionAckMatches 按 commandId/deviceId/sessionId/action 认人）。
        return { kind: 'accepted', command: { ...command, state: 'resolved', result } };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

const identity = createIdentity();

function savedStore() {
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
      deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-waiting'] },
  });
}

function storeWith() {
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => savedStore(),
    write: async () => {},
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
  };
  return createCompanionStore(companion, () => {});
}

async function connectedStore() {
  const store = storeWith();
  await store.getState().hydrate();
  expect(store.getState().status).toBe('connected');
  return store;
}

describe('companionStore.run.cancel 的 alreadyTerminal 结算', () => {
  it('宿主结算 alreadyTerminal：清当前 runId，结束「正在处理」', async () => {
    const store = await connectedStore();
    store.setState({ runId: 'run-waiting', terminal: null });

    await store.getState().stop();

    expect(store.getState().runId).toBeNull();
    expect(store.getState().terminal).toBe('stopped');
    expect(store.getState().pending).toBe(false);
  });

  it('结算到达时 runId 已经换成新一次执行：不清新 runId', async () => {
    const store = await connectedStore();
    store.setState({ runId: 'run-waiting', terminal: null });

    // stop() 送出 run-waiting 之后、回执到达之前，会话里已经起了新一次执行。
    const stopPromise = store.getState().stop();
    store.setState({ runId: 'run-next' });
    await stopPromise;

    expect(store.getState().runId).toBe('run-next');
  });

  it('不带 alreadyTerminal 标记的结算不碰 runId', async () => {
    const store = await connectedStore();
    store.setState({ runId: 'run-live', terminal: null });
    harness.resultsByPayloadRunId.set('run-live', {});

    await store.getState().stop();

    expect(store.getState().runId).toBe('run-live');
    expect(store.getState().pending).toBe(false);
  });
});
