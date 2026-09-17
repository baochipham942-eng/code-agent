import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import { createMobileStore } from '../../../packages/mobile/src/stores/mobileStore';
import { HistoryCache } from '../../../packages/mobile/src/platform/historyCache';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-MOBILE-RESUME-LAST-SESSION（FB-186）：按电脑记住上次打开的会话；
 * 冷启动用缓存立即打开；电脑连不上也打开；删会话/欢迎页/换电脑落欢迎页。
 */
const HOST = 'aa'.repeat(32);
const harness = vi.hoisted(() => ({
  recoverError: null as string | null,
  libraryNextOffset: null as number | null,
  librarySessions: [{ id: 's-keep', title: '上次会话', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' }] as { id: string; title: string; projectId: string | null; updatedAt: number; archived: boolean; provider: string; model: string }[],
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      if (harness.recoverError) throw new Error(harness.recoverError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [{ id: 'm1', role: 'user', content: 'cached', timestamp: 1 }], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return {
          nextOffset: harness.libraryNextOffset,
          projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w' }],
          sessions: harness.librarySessions,
          models: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek', providerLabel: 'DeepSeek', isDefault: true }],
        };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function disk(initial: string | null = null) {
  let value = initial;
  return { get: async () => value, set: async (next: string) => { value = next; }, snapshot: () => value };
}

function identityRecord() {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

function companionPort(raw: string): NonNullable<PlatformPorts['companion']> {
  return {
    read: async () => raw, write: async () => {}, scan: async () => '', post: async () => ({}),
  };
}

describe('mobileStore.lastSessions 按电脑持久化', () => {
  it('冷启动后仍记得上次打开的会话 id（含欢迎页空串）', async () => {
    const port = disk();
    const first = createMobileStore(port);
    await first.getState().hydrate();
    first.getState().rememberSession(HOST, 's-keep');
    await first.getState().flush();
    const second = createMobileStore(port);
    await second.getState().hydrate();
    expect(second.getState().preferences.lastSessions).toEqual({ [HOST]: 's-keep' });
    second.getState().rememberSession(HOST, null);
    await second.getState().flush();
    const third = createMobileStore(port);
    await third.getState().hydrate();
    expect(third.getState().preferences.lastSessions?.[HOST]).toBe('');
  });
});

describe('companionStore 冷启动回到上次会话', () => {
  beforeEach(() => {
    harness.recoverError = null;
    harness.libraryNextOffset = null;
    harness.librarySessions = [{ id: 's-keep', title: '上次会话', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' }];
  });
  afterEach(() => { harness.recoverError = null; });

  it('有缓存历史时立即打开上次会话，不等电脑（recover 失败也打开）', async () => {
    const history = new HistoryCache();
    history.putMessages('s-keep', [{ id: 'm1', role: 'user', content: '昨晚写到这里', timestamp: 1 }]);
    harness.recoverError = 'COMPANION_NETWORK_UNAVAILABLE';
    const store = createCompanionStore(companionPort(identityRecord()), () => {}, undefined, undefined, history, {
      lastSession: () => 's-keep',
    });
    await store.getState().hydrate();
    expect(store.getState().sessionId).toBe('s-keep');
    expect(store.getState().history['s-keep']?.messages[0]?.content).toBe('昨晚写到这里');
    expect(store.getState().status).toBe('offline');
    store.getState().pause();
  });

  it('上次在欢迎页：即使 scope 以后会有会话也不打开', async () => {
    const store = createCompanionStore(companionPort(identityRecord()), () => {}, undefined, undefined, undefined, {
      lastSession: () => '',
    });
    await store.getState().hydrate();
    expect(store.getState().sessionId).toBeNull();
    store.getState().pause();
  });

  it('连上后库里没有当前会话（电脑已删）：静默回欢迎页', async () => {
    const history = new HistoryCache();
    history.putMessages('s-gone', [{ id: 'm1', role: 'user', content: 'deleted on host', timestamp: 1 }]);
    harness.librarySessions = [];
    const remembered: Array<string | null> = [];
    const store = createCompanionStore(companionPort(identityRecord()), () => {}, undefined, undefined, history, {
      lastSession: () => 's-gone',
      rememberSession: (_host, id) => { remembered.push(id); },
    });
    await store.getState().hydrate();
    expect(store.getState().sessionId).toBe('s-gone');
    await store.getState().refreshLibrary();
    expect(store.getState().sessionId).toBeNull();
    expect(remembered.at(-1)).toBeNull();
    store.getState().pause();
  });

  it('加载更多后的会话，第一页刷新未完结时不当成电脑删除', async () => {
    const page1 = { id: 'page-1', title: '第一页', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' };
    const older = { id: 's-old', title: '较老', projectId: 'one', updatedAt: 1, archived: false, provider: 'deepseek', model: 'deepseek-chat' };
    harness.librarySessions = [page1];
    harness.libraryNextOffset = 1;
    const history = new HistoryCache();
    history.putMessages('s-old', [{ id: 'm1', role: 'user', content: 'older', timestamp: 1 }]);
    const store = createCompanionStore(companionPort(identityRecord()), () => {}, undefined, undefined, history, {
      lastSession: () => 's-old',
    });
    await store.getState().hydrate();
    await store.getState().refreshLibrary();
    expect(store.getState().sessionId).toBe('s-old');
    harness.librarySessions = [older];
    await store.getState().refreshLibrary(true);
    expect(store.getState().library?.sessions.map(s => s.id)).toEqual(['page-1', 's-old']);
    harness.librarySessions = [page1];
    harness.libraryNextOffset = 1;
    await store.getState().refreshLibrary();
    expect(store.getState().sessionId).toBe('s-old');
    store.getState().pause();
  });

  it('缓存里有的会话，selectSession 在 library 还没到时也能打开', async () => {
    const history = new HistoryCache();
    history.putMessages('s-keep', [{ id: 'm1', role: 'user', content: 'cached', timestamp: 1 }]);
    const store = createCompanionStore(companionPort(identityRecord()), () => {}, undefined, undefined, history, {
      lastSession: () => '',
    });
    await store.getState().hydrate();
    expect(store.getState().sessionId).toBeNull();
    store.getState().selectSession('s-keep');
    expect(store.getState().sessionId).toBe('s-keep');
    store.getState().pause();
  });
});
