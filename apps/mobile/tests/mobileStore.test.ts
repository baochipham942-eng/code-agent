import { describe, expect, it } from 'vitest';
import { createMobileStore } from '../src/stores/mobileStore';

function disk(initial: string | null = null) {
  let value = initial;
  return { get: async () => value, set: async (next: string) => { value = next; } };
}

describe('mobile draft and navigation behavior', () => {
  it('cold starts a new conversation and retains the saved draft and theme after process replacement', async () => {
    const port = disk();
    const first = createMobileStore(port); await first.getState().hydrate();
    first.getState().editDraft('你好\n继续这件事'); first.getState().setAppearance('dark');
    first.getState().navigate('fixture'); first.getState().openDrawer();
    await first.getState().flush();
    const second = createMobileStore(port); await second.getState().hydrate();
    expect(second.getState()).toMatchObject({ route: 'new', drawer: false, sheet: null,
      preferences: { drafts: { new: '你好\n继续这件事' }, appearance: 'dark' } });
  });
  it('sending without Host acknowledgement retains text and records no accepted task', async () => {
    const store = createMobileStore(disk()); await store.getState().hydrate();
    store.getState().editDraft('未确认的消息'); store.getState().attemptSend(); await store.getState().flush();
    expect(store.getState().preferences.drafts.new).toBe('未确认的消息');
    expect(store.getState().sendAttempted).toBe(true);
  });
  it('keeps separate drafts when switching conversations', async () => {
    const store = createMobileStore(disk()); await store.getState().hydrate();
    store.getState().editDraft('新草稿'); store.getState().navigate('fixture'); store.getState().editDraft('示例草稿');
    store.getState().navigate('new');
    expect(store.getState().preferences.drafts).toEqual({ new: '新草稿', fixture: '示例草稿' });
  });
  it('pops one sheet page, dismisses to its drawer origin and preserves unsaved form input', async () => {
    const store = createMobileStore(disk()); await store.getState().hydrate();
    const s = store.getState(); s.openDrawer(); s.openSheet('settings'); s.pushSheet('profile'); s.editProfile('未提交');
    expect(store.getState().sheet).toEqual({ origin: 'drawer', pages: ['settings', 'profile'] });
    s.back(); expect(store.getState().sheet?.pages).toEqual(['settings']);
    s.closeSheet();
    expect(store.getState()).toMatchObject({ drawer: true, sheet: null, profileDraft: '未提交', preferences: { nickname: '' } });
  });
  it('does not create a second active sheet when another root is requested', async () => {
    const store = createMobileStore(disk()); await store.getState().hydrate();
    store.getState().openSheet('more'); store.getState().openSheet('settings');
    expect(store.getState().sheet?.pages).toEqual(['more']);
  });
  it('hands root back to the OS after consuming sheet and drawer', async () => {
    const store = createMobileStore(disk()); await store.getState().hydrate(); const s = store.getState();
    s.openDrawer(); s.openSheet('settings'); s.pushSheet('about');
    expect(s.back()).toBe(true); expect(s.back()).toBe(true); expect(s.back()).toBe(true); expect(s.back()).toBe(false);
  });
  it('saves a profile only on explicit save and restores it on restart', async () => {
    const port = disk(); const store = createMobileStore(port); await store.getState().hydrate();
    store.getState().editProfile('  Neo tester  '); await store.getState().flush(); expect(await port.get()).toBe(null);
    store.getState().saveProfile(); await store.getState().flush();
    const second = createMobileStore(port); await second.getState().hydrate();
    expect(second.getState().preferences.nickname).toBe('Neo tester');
  });
});

describe('persistence failure boundaries', () => {
  it('serializes writes so a slow old draft cannot overwrite the newest draft', async () => {
    let release!: () => void; let value: string | null = null; let calls = 0;
    const port = { get: async () => value, set: async (next: string) => {
      if (++calls === 1) await new Promise<void>(resolve => { release = resolve; }); value = next;
    } };
    const store = createMobileStore(port); await store.getState().hydrate();
    store.getState().editDraft('first'); await Promise.resolve(); store.getState().editDraft('latest');
    expect(calls).toBe(1); release(); await store.getState().flush();
    const second = createMobileStore(port); await second.getState().hydrate();
    expect(second.getState().preferences.drafts.new).toBe('latest');
  });
  it('keeps the draft and reports failed writes, then persists the current snapshot on retry', async () => {
    let fail = true; const storage = disk();
    const port = { get: storage.get, set: async (value: string) => { if (fail) throw new Error('DISK_FULL'); await storage.set(value); } };
    const store = createMobileStore(port); await store.getState().hydrate(); store.getState().editDraft('保留');
    await store.getState().flush(); expect(store.getState().saveError).toBe(true);
    expect(store.getState().preferences.drafts.new).toBe('保留');
    fail = false; await store.getState().flush(); expect(store.getState().saveError).toBe(false);
    expect(JSON.parse((await storage.get())!).drafts.new).toBe('保留');
  });
  it('does not overwrite unread storage with defaults and allows a read retry', async () => {
    let fail = true, writes = 0;
    const store = createMobileStore({ get: async () => { if (fail) throw new Error('READ_FAILED'); return null; }, set: async () => { writes++; } });
    await store.getState().hydrate(); store.getState().editDraft('must not persist');
    expect(store.getState()).toMatchObject({ ready: false, loadError: true }); expect(writes).toBe(0);
    fail = false; await store.getState().hydrate(); expect(store.getState().ready).toBe(true);
  });
  it.each(['{broken', '{"schema":2}', '{"schema":1,"drafts":{"new":2,"fixture":""},"appearance":"dark","nickname":""}'])(
    'preserves malformed or unsupported preference data: %s', async raw => {
      const port = disk(raw); const store = createMobileStore(port); await store.getState().hydrate();
      store.getState().setAppearance('light'); await store.getState().flush();
      expect(store.getState().ready).toBe(false); expect(await port.get()).toBe(raw);
    });
});
