import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { CompanionCommand } from '../../../src/shared/contract/companion';
import type { PickedFile } from '../../../packages/mobile/src/platform/ports';

const harness = vi.hoisted(() => ({
  beforeChunk: async (_command: CompanionCommand) => {},
  failAction: null as CompanionCommand['action'] | null,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => {
  const binding = {
    version: 1 as const, endpoint: 'http://10.0.0.1:8182', hostKey: 'aa'.repeat(32),
    deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'],
  };
  return {
    LanCompanionClient: class {
      async pair() { return binding; }
      async recover(_target: unknown, existing?: typeof binding) { return existing ?? binding; }
      async request(payload: { action?: string; command?: CompanionCommand }) {
        const command = payload.command;
        if (!command) return { kind: 'accepted', command: { state: 'accepted', result: {} } };
        if (command.action === 'files.chunk') await harness.beforeChunk(command);
        if (harness.failAction === command.action) throw new Error('COMPANION_CHANNEL_CLOSED');
        const result = command.action === 'files.prepare' ? { transferId: 'xfer-1' }
          : command.action === 'files.commit' ? { artifactId: 'art-1', version: 1 }
          : {};
        return { kind: 'accepted', command: { ...command, state: 'accepted', result } };
      }
      close() {}
    },
  };
});

function seed(extra: Record<string, unknown> = {}) {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1,
    publicKey: toHex(identity.publicKey),
    secretKey: toHex(identity.secretKey),
    binding: {
      version: 1, endpoint: 'http://10.0.0.1:8182', hostKey: toHex(identity.publicKey),
      deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'],
    },
    ...extra,
  });
}

function txt(bytes: Uint8Array, name = 'note.txt'): PickedFile {
  return { name, mimeType: 'text/plain', size: bytes.byteLength, bytes };
}

async function connected(writes: string[] = []) {
  let storage: string | null = seed();
  const store = createCompanionStore({
    read: async () => storage,
    write: async value => { writes.push(value); storage = value; },
    scan: async () => '',
    post: async () => ({}),
  }, () => {});
  await store.getState().hydrate();
  expect(store.getState().status).toBe('connected');
  expect(store.getState().sessionId).toBe('session-1');
  return { store, writes, storage: () => storage };
}

describe('uploadProgress 从既有 upload 循环导出且不进 persist', () => {
  beforeEach(() => {
    harness.beforeChunk = async () => {};
    harness.failAction = null;
  });
  afterEach(() => {
    harness.beforeChunk = async () => {};
    harness.failAction = null;
  });

  it('chunk 循环把 sentBytes 推到 chip，完成态 sentBytes=totalBytes', async () => {
    const { store } = await connected();
    const bytes = new Uint8Array(COMPANION_LIMITS.fileChunkBytes + 12);
    let sawMid = false;
    harness.beforeChunk = async () => {
      const item = store.getState().uploadProgress[0];
      if (item?.phase === 'transferring' && item.sentBytes === COMPANION_LIMITS.fileChunkBytes) sawMid = true;
    };
    await store.getState().upload(txt(bytes));
    expect(sawMid).toBe(true);
    expect(store.getState().uploadProgress).toEqual([expect.objectContaining({
      name: 'note.txt', phase: 'complete', sentBytes: bytes.byteLength, totalBytes: bytes.byteLength,
    })]);
    expect(store.getState().commandError).toBeNull();
  });

  it('失败归到具体附件，不写 commandError；可重传、可移除', async () => {
    const { store } = await connected();
    harness.failAction = 'files.chunk';
    const bytes = new Uint8Array(8);
    await store.getState().upload(txt(bytes));
    const failed = store.getState().uploadProgress[0];
    expect(failed).toMatchObject({ name: 'note.txt', phase: 'failed', error: 'COMPANION_CHANNEL_CLOSED' });
    expect(store.getState().commandError).toBeNull();
    expect(store.getState().pending).toBe(false);

    harness.failAction = null;
    await store.getState().retryUpload(failed.id);
    expect(store.getState().uploadProgress[0]).toMatchObject({ id: failed.id, phase: 'complete' });

    store.getState().removeUpload(failed.id);
    expect(store.getState().uploadProgress).toEqual([]);
  });

  it('类型拒绝不可重传，移除后 chip 消失且不改 persist 里的草稿字段', async () => {
    const { store, writes } = await connected();
    await store.getState().upload(txt(new Uint8Array([1, 2, 3]), 'payload.exe'));
    const failed = store.getState().uploadProgress[0];
    expect(failed).toMatchObject({ phase: 'failed', error: 'COMPANION_FILE_TYPE_DENIED' });
    await store.getState().retryUpload(failed.id);
    expect(store.getState().uploadProgress[0]?.phase).toBe('failed');
    store.getState().removeUpload(failed.id);
    expect(store.getState().uploadProgress).toEqual([]);
    for (const raw of writes) {
      expect(JSON.parse(raw)).not.toHaveProperty('drafts');
      expect(JSON.parse(raw)).not.toHaveProperty('uploadProgress');
    }
  });

  it('hydrate 忽略盘上的 uploadProgress，upload 过程的 write 也不带这个字段', async () => {
    const poisoned = seed({ uploadProgress: [{ id: 'sneaky', phase: 'transferring', sentBytes: 9 }] });
    const writes: string[] = [];
    let storage: string | null = poisoned;
    const first = createCompanionStore({
      read: async () => storage,
      write: async value => { writes.push(value); storage = value; },
      scan: async () => '',
      post: async () => ({}),
    }, () => {});
    await first.getState().hydrate();
    expect(first.getState().uploadProgress).toEqual([]);
    await first.getState().upload(txt(new Uint8Array([1, 2, 3, 4])));
    expect(first.getState().uploadProgress[0]?.phase).toBe('complete');
    for (const raw of writes) {
      expect(Object.keys(JSON.parse(raw))).not.toContain('uploadProgress');
    }
    const second = createCompanionStore({
      read: async () => storage, write: async () => {}, scan: async () => '', post: async () => ({}),
    }, () => {});
    await second.getState().hydrate();
    expect(second.getState().uploadProgress).toEqual([]);
  });

  it('keeps a tiny file in transferring until the minimum chip window', async () => {
    const { store } = await connected();
    const pending = store.getState().upload(txt(new Uint8Array([1, 2, 3, 4])));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(store.getState().uploadProgress[0]?.phase).not.toBe('complete');
    await pending;
    expect(store.getState().uploadProgress[0]?.phase).toBe('complete');
  });
});
