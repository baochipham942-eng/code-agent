import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import { createMobileStore } from '../../../packages/mobile/src/stores/mobileStore';
import { FileCache } from '../../../packages/mobile/src/platform/fileCache';
import { HistoryCache } from '../../../packages/mobile/src/platform/historyCache';
import { messages, offlineHistoryCopy } from '../../../packages/mobile/src/i18n';
import type { CompanionCommand, CompanionEvent } from '../../../src/shared/contract/companion';

const harness = vi.hoisted(() => ({
  recoverError: null as string | null,
  recoverScope: null as string[] | null,
  syncResult: { kind: 'events' as string, epoch: 1, nextSeq: 0, events: [] as CompanionEvent[] },
  commandKind: 'accepted' as string,
  commandReason: undefined as string | undefined,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => {
  const binding = {
    version: 1 as const, endpoint: 'http://10.0.0.1:8182', hostKey: 'aa'.repeat(32),
    deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'],
  };
  return {
    LanCompanionClient: class {
      async pair() { return binding; }
      async recover(_target: unknown, existing?: typeof binding) {
        if (harness.recoverError) throw new Error(harness.recoverError);
        const base = existing ?? binding;
        return harness.recoverScope ? { ...base, scope: harness.recoverScope } : base;
      }
      async request(payload: { action?: string; command?: CompanionCommand }) {
        if (payload.action === 'sync') return harness.syncResult;
        if (payload.action === 'read') {
          return { sessionId: 'session-1', messages: [], nextOffset: null };
        }
        if (payload.action === 'command' && payload.command) {
          return {
            kind: harness.commandKind,
            reason: harness.commandReason,
            command: { ...payload.command, state: harness.commandKind === 'accepted' ? 'accepted' : 'rejected', result: {} },
          };
        }
        return { kind: 'accepted', command: { state: 'accepted', result: {} } };
      }
      close() {}
    },
  };
});

function disk(initial: string | null = null) {
  let value = initial;
  return { read: async () => value, write: async (next: string) => { value = next; }, snapshot: () => value };
}

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

function messageEvent(id: string, content: string, seq: number, sessionId = 'session-1'): CompanionEvent {
  return {
    eventId: `e-${id}`, epoch: 1, seq, sessionId, kind: 'message',
    payload: { id, role: 'user', content }, createdAt: 1_700_000_000_000 + seq,
  };
}

function cardEvent(kind: 'approval' | 'question' | 'plan', requestId: string, seq: number): CompanionEvent {
  return {
    eventId: `c-${requestId}`, epoch: 1, seq, sessionId: 'session-1', kind,
    payload: { requestId, status: 'pending', revision: 1, preview: '{"ok":true}' }, createdAt: 1_700_000_000_000 + seq,
  };
}

async function connected(history: HistoryCache, identity: ReturnType<typeof disk> = disk(seed())) {
  harness.recoverError = null;
  const store = createCompanionStore({
    read: () => identity.read(),
    write: value => identity.write(value),
    scan: async () => '',
    post: async () => ({}),
  }, () => {}, undefined, undefined, history);
  await store.getState().hydrate();
  expect(store.getState().status).toBe('connected');
  return { store, identity };
}

describe('offline conversation cache', () => {
  beforeEach(() => {
    harness.recoverError = null;
    harness.recoverScope = null;
    harness.syncResult = { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    harness.commandKind = 'accepted';
    harness.commandReason = undefined;
  });
  afterEach(() => {
    harness.recoverError = null;
    harness.recoverScope = null;
    harness.commandKind = 'accepted';
    harness.commandReason = undefined;
  });

  it('evicts older sessions by atime when the total quota is exceeded', () => {
    let now = 1;
    const long = 'x'.repeat(80);
    const cache = new HistoryCache(220, COMPANION_LIMITS.historyWindowMessages, () => now);
    cache.putMessages('old', [{ id: 'a', role: 'user', content: long, timestamp: 1 }]);
    now = 2;
    cache.putMessages('keep', [{ id: 'b', role: 'user', content: long, timestamp: 2 }]);
    expect(cache.snapshot().history.old).toBeUndefined();
    expect(cache.snapshot().history.keep.messages.map(message => message.id)).toEqual(['b']);
  });

  it('caps each session at the history window, keeping the newest messages', () => {
    const cache = new HistoryCache(COMPANION_LIMITS.historyCacheQuotaBytes, 2);
    cache.putMessages('keep', [
      { id: 'b', role: 'user', content: 'b', timestamp: 2 },
      { id: 'c', role: 'user', content: 'c', timestamp: 3 },
      { id: 'd', role: 'user', content: 'd', timestamp: 4 },
    ]);
    expect(cache.snapshot().history.keep.messages.map(message => message.id)).toEqual(['c', 'd']);
    expect(COMPANION_LIMITS.historyWindowMessages).toBe(1000);
  });

  it('writes sync-landed message bodies and tool cards, then hydrates them offline as read-only', async () => {
    const historyDisk = disk();
    const history = new HistoryCache(COMPANION_LIMITS.historyCacheQuotaBytes, COMPANION_LIMITS.historyWindowMessages, Date.now, historyDisk);
    const { store, identity } = await connected(history);
    harness.syncResult = {
      kind: 'events', epoch: 1, nextSeq: 2,
      events: [messageEvent('m1', 'cached body', 1), cardEvent('approval', 'req-1', 2)],
    };
    await store.getState().sync();
    await history.flush();
    expect(store.getState().lastSyncAt).toBeTruthy();
    const saved = JSON.parse(identity.snapshot()!);
    expect(saved.pending).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('cached body');

    harness.recoverError = 'COMPANION_NETWORK_UNAVAILABLE';
    const restarted = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    const cold = createCompanionStore({
      read: () => identity.read(), write: value => identity.write(value), scan: async () => '', post: async () => ({}),
    }, () => {}, undefined, undefined, restarted);
    await cold.getState().hydrate();
    expect(cold.getState().status).toBe('offline');
    expect(cold.getState().history['session-1']?.messages).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'cached body' }),
    ]);
    expect(cold.getState().events).toEqual([expect.objectContaining({ kind: 'approval', payload: expect.objectContaining({ requestId: 'req-1' }) })]);
    const text = messages('zh');
    expect(offlineHistoryCopy(text, cold.getState(), true)).toContain(text.offlineReadonly);
    expect(offlineHistoryCopy(text, cold.getState(), true)).toContain(text.lastSynced);
  });

  it('does not cache streaming deltas or tool arguments that are not in the projection', async () => {
    const historyDisk = disk();
    const history = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    const { store } = await connected(history);
    harness.syncResult = {
      kind: 'events', epoch: 1, nextSeq: 2,
      events: [
        {
          eventId: 'delta', epoch: 1, seq: 1, sessionId: 'session-1', kind: 'message_delta',
          payload: { role: 'assistant', path: 'content', op: 'append', text: 'partial', arguments: { cmd: 'rm' } },
          createdAt: 1,
        },
        {
          eventId: 'tool', epoch: 1, seq: 2, sessionId: 'session-1', kind: 'tool_call_start',
          payload: { id: 't1', name: 'bash', arguments: { command: 'secret' } },
          createdAt: 2,
        },
      ],
    };
    await store.getState().sync();
    await history.flush();
    expect(history.snapshot().history['session-1']).toBeUndefined();
    expect(history.snapshot().events).toEqual([]);
  });

  it('clears all history cache when the host revokes the device', async () => {
    const historyDisk = disk();
    const history = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    const { store } = await connected(history);
    harness.syncResult = { kind: 'events', epoch: 1, nextSeq: 1, events: [messageEvent('m1', 'secret chat', 1)] };
    await store.getState().sync();
    await history.flush();
    expect(historyDisk.snapshot()).toContain('secret chat');
    harness.syncResult = { kind: 'revoked', epoch: 1, nextSeq: 1, events: [] };
    await store.getState().sync();
    await history.flush();
    expect(store.getState().status).toBe('rejected');
    expect(store.getState().history).toEqual({});
    expect(store.getState().events).toEqual([]);
    expect(history.snapshot().history).toEqual({});
    expect(historyDisk.snapshot()).not.toContain('secret chat');
  });

  it('clears all history cache on a device-level command rejection', async () => {
    const historyDisk = disk();
    const history = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    const { store } = await connected(history);
    harness.syncResult = { kind: 'events', epoch: 1, nextSeq: 1, events: [messageEvent('m1', 'keep-until-revoked', 1)] };
    await store.getState().sync();
    await history.flush();
    harness.commandKind = 'rejected';
    harness.commandReason = 'device_revoked';
    await store.getState().send('will be refused');
    await history.flush();
    expect(store.getState().status).toBe('rejected');
    expect(history.snapshot().history).toEqual({});
    expect(historyDisk.snapshot()).not.toContain('keep-until-revoked');
  });

  it('settings clear-cache drops history but keeps drafts', async () => {
    const prefs = disk();
    const historyDisk = disk();
    const history = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    const cache = new FileCache(1024);
    cache.put('preview', { name: 'shot.png', mimeType: 'image/png', bytes: new Uint8Array([9, 9]) });
    const mobile = createMobileStore({ get: () => prefs.read(), set: value => prefs.write(value) });
    await mobile.getState().hydrate();
    mobile.getState().editDraft('keep-this-draft');
    await mobile.getState().flush();
    const identity = disk(seed());
    const store = createCompanionStore({
      read: () => identity.read(), write: value => identity.write(value), scan: async () => '', post: async () => ({}),
    }, () => {}, undefined, {
      cache, pick: async () => null, save: async () => ({ status: 'cancelled' as const }),
    }, history);
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    harness.syncResult = { kind: 'events', epoch: 1, nextSeq: 1, events: [messageEvent('m1', 'cached body', 1)] };
    await store.getState().sync();
    await history.flush();
    const usage = store.getState().clearCache();
    await history.flush();
    expect(usage.conversationBytes).toBeGreaterThan(0);
    expect(cache.get('preview')).toBeNull();
    expect(store.getState().history).toEqual({});
    expect(historyDisk.snapshot()).not.toContain('cached body');
    expect(JSON.parse((await prefs.read())!).drafts.new).toBe('keep-this-draft');
  });

  it('drops cached sessions that leave binding.scope after reconnect', async () => {
    const historyDisk = disk();
    const history = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    history.putMessages('session-1', [{ id: 'a', role: 'user', content: 'keep-me', timestamp: 1 }]);
    history.putMessages('session-2', [{ id: 'b', role: 'user', content: 'revoked-session', timestamp: 1 }]);
    await history.flush();
    const identity = createIdentity();
    const storage = disk(JSON.stringify({
      version: 1,
      publicKey: toHex(identity.publicKey),
      secretKey: toHex(identity.secretKey),
      binding: {
        version: 1, endpoint: 'http://10.0.0.1:8182', hostKey: toHex(identity.publicKey),
        deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1', 'session-2'],
      },
    }));
    harness.recoverScope = ['session-1'];
    const store = createCompanionStore({
      read: () => storage.read(), write: value => storage.write(value), scan: async () => '', post: async () => ({}),
    }, () => {}, undefined, undefined, history);
    await store.getState().hydrate();
    await history.flush();
    expect(store.getState().status).toBe('connected');
    expect(store.getState().history['session-1']?.messages[0]?.content).toBe('keep-me');
    expect(store.getState().history['session-2']).toBeUndefined();
    expect(history.snapshot().history['session-2']).toBeUndefined();
    expect(historyDisk.snapshot()).not.toContain('revoked-session');
  });

  it('applies the per-session window when hydrating a disk cache that is too long', async () => {
    const historyDisk = disk(JSON.stringify({
      version: 1, lastSyncAt: 1,
      sessions: {
        'session-1': {
          messages: [
            { id: 'a', role: 'user', content: 'old', timestamp: 1 },
            { id: 'b', role: 'user', content: 'mid', timestamp: 2 },
            { id: 'c', role: 'user', content: 'new', timestamp: 3 },
          ],
          cards: [], atime: 1,
        },
      },
    }));
    const cache = new HistoryCache(undefined, 2, Date.now, historyDisk);
    await cache.hydrate();
    expect(cache.snapshot().history['session-1'].messages.map(message => message.id)).toEqual(['b', 'c']);
  });

  it('drops history cache when pairing identity is gone', async () => {
    const historyDisk = disk();
    const primed = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    primed.putMessages('session-1', [{ id: 'm1', role: 'user', content: 'orphan', timestamp: 1 }]);
    await primed.flush();
    expect(historyDisk.snapshot()).toContain('orphan');
    const empty = new HistoryCache(undefined, undefined, Date.now, historyDisk);
    const store = createCompanionStore({
      read: async () => null, write: async () => {}, scan: async () => '', post: async () => ({}),
    }, () => {}, undefined, undefined, empty);
    await store.getState().hydrate();
    await empty.flush();
    expect(historyDisk.snapshot()).not.toContain('orphan');
    expect(store.getState().history).toEqual({});
  });
});

describe('offlineHistoryCopy', () => {
  const text = messages('zh');
  it('names the cache as offline read-only and does not pretend the computer is connected', () => {
    expect(offlineHistoryCopy(text, { status: 'offline', paused: false, lastSyncAt: 1_700_000_000_000 }, true)).toContain(text.offlineReadonly);
    expect(offlineHistoryCopy(text, { status: 'connected', paused: false, lastSyncAt: 1 }, true)).toBeNull();
    expect(offlineHistoryCopy(text, { status: 'offline', paused: true, lastSyncAt: 1 }, true)).toBeNull();
    expect(offlineHistoryCopy(text, { status: 'offline', paused: false, lastSyncAt: null }, false)).toBeNull();
  });
});
