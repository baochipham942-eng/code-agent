import { describe, expect, it } from 'vitest';
import { createMobileStore, joinTranscript } from '../../../packages/mobile/src/stores/mobileStore';
import { canAddressSession } from '../../../packages/mobile/src/stores/companionStore';

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
  it('does not acknowledge a cleared draft until its write succeeds, including a retry after in-memory clearing', async () => {
    const storage = disk(); let fail = false;
    const store = createMobileStore({ get: storage.get, set: async value => { if (fail) throw new Error('DISK_FULL'); await storage.set(value); } });
    await store.getState().hydrate(); store.getState().editDraft('accepted task'); await store.getState().flush();
    fail = true;
    await expect(store.getState().acknowledgeDraft('accepted task')).rejects.toThrow('DRAFT_NOT_SAVED');
    await expect(store.getState().acknowledgeDraft('accepted task')).rejects.toThrow('DRAFT_NOT_SAVED');
    expect(JSON.parse((await storage.get())!).drafts.new).toBe('accepted task');
    fail = false; await store.getState().acknowledgeDraft('accepted task');
    expect(JSON.parse((await storage.get())!).drafts.new).toBe('');
  });
  it('preserves newly edited text and other drafts when an older message is acknowledged', async () => {
    const storage = disk(); const store = createMobileStore(storage); await store.getState().hydrate();
    store.getState().editDraft('newer text'); store.getState().navigate('fixture'); store.getState().editDraft('accepted task');
    await store.getState().acknowledgeDraft('accepted task');
    expect(store.getState().preferences.drafts).toEqual({ new: 'newer text', fixture: 'accepted task' });
  });
  it('waits for a newer draft write if it was queued during a failed acknowledgement write', async () => {
    const storage = disk(); let count = 0;
    let releaseClear!: () => void; let releaseNew!: () => void;
    const store = createMobileStore({ get: storage.get, set: async value => {
      const current = ++count;
      if (current === 2) { await new Promise<void>(resolve => { releaseClear = resolve; }); throw new Error('WRITE_FAILED'); }
      if (current === 3) await new Promise<void>(resolve => { releaseNew = resolve; });
      await storage.set(value);
    } });
    await store.getState().hydrate(); store.getState().editDraft('accepted'); await store.getState().flush();
    let acknowledged = false;
    const ack = store.getState().acknowledgeDraft('accepted').then(() => { acknowledged = true; });
    await Promise.resolve(); store.getState().editDraft('new text'); releaseClear();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(acknowledged).toBe(false);
    releaseNew(); await ack;
    expect(JSON.parse((await storage.get())!).drafts.new).toBe('new text');
  });
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

describe('real conversation draft identity', () => {
  it('preserves the old draft on first pairing and isolates hosts and sessions through restart', async () => {
    const port = disk(); const store = createMobileStore(port); await store.getState().hydrate();
    store.getState().editDraft('build 15 draft');
    store.getState().activateDraft('host-a:session-a');
    expect(store.getState().preferences.drafts['host-a:session-a']).toBe('build 15 draft');
    store.getState().activateDraft('host-a:session-b'); store.getState().editDraft('second draft');
    store.getState().activateDraft('host-b:session-a'); store.getState().editDraft('other computer');
    await store.getState().acknowledgeDraft('build 15 draft', 'host-a:session-a');
    const restored = createMobileStore(port); await restored.getState().hydrate();
    expect(restored.getState().preferences.drafts).toMatchObject({ 'host-a:session-a': '', 'host-a:session-b': 'second draft', 'host-b:session-a': 'other computer' });
  });
  it('late acknowledgements do not clear edits to the same conversation', async () => {
    const store = createMobileStore(disk()); await store.getState().hydrate();
    store.getState().activateDraft('host:session'); store.getState().editDraft('newer text');
    await store.getState().acknowledgeDraft('old text', 'host:session');
    expect(store.getState().preferences.drafts['host:session']).toBe('newer text');
  });
});

it('transcription receipts append once to the originating draft and never send it', async () => {
  const port = disk(); const store = createMobileStore(port); await store.getState().hydrate();
  store.getState().activateDraft('host:a'); store.getState().editDraft('existing');
  store.getState().activateDraft('host:b'); store.getState().editDraft('other session');
  await store.getState().appendTranscript('spoken words', 'host:a', 'voice-command');
  const next = createMobileStore(port); await next.getState().hydrate();
  await next.getState().appendTranscript('spoken words', 'host:a', 'voice-command');
  expect(next.getState().preferences.drafts['host:a']).toBe('existing\nspoken words');
  expect(next.getState().preferences.drafts['host:b']).toBe('other session');
  expect(next.getState().sendAttempted).toBe(false);
});

it('分片续写接着上一段写，不在用户句子里插换行', async () => {
  const store = createMobileStore(disk()); await store.getState().hydrate();
  store.getState().activateDraft('host:a'); store.getState().editDraft('我先说一句');
  await store.getState().appendTranscript('帮我整理资料', 'host:a', 'chunk-1');
  await store.getState().appendTranscript('重点看定位', 'host:a', 'chunk-2', true);
  // 第一段与用户已打的字分行；同一次录音的第二段接着写
  expect(store.getState().preferences.drafts['host:a']).toBe('我先说一句\n帮我整理资料重点看定位');
});

describe('joinTranscript', () => {
  it.each([
    ['空草稿直接用转写结果', '', '你好', false, '你好'],
    ['整段转写另起一行', '已有文字', '你好', false, '已有文字\n你好'],
    ['中文分片续写不补空格', '重点看一下它们的', '定位和传播方式', true, '重点看一下它们的定位和传播方式'],
    ['中文标点结尾也不补空格', '整理好了。', '还要补一页', true, '整理好了。还要补一页'],
    ['英文分片续写补一个空格，别把两个词粘死', 'brand research', 'and positioning', true, 'brand research and positioning'],
    ['空转写不动草稿', '已有文字', '', true, '已有文字'],
  ])('%s', (_name, draft, text, continuation, expected) => {
    expect(joinTranscript(draft, text, continuation)).toBe(expected);
  });
});

// ai-review #1742 Important：send / transcribe / respond 三处在没有可寻址会话时都是**静默
// return**。界面若只按 status==='connected' 分流，用只勾项目的二维码配对（本 PR 新增的项目
// 授权形态）后 sessionId 为 null，手机写着「已连接，可以发任务」，点发送却什么都不发生——
// 无报错、无提示、无 pending、草稿不清，用户只能反复点。这条判据是那三处与界面的唯一共用来源。
describe('canAddressSession', () => {
  it.each([
    ['已连接且选了会话', { status: 'connected' as const, sessionId: 's1' }, true],
    ['已连接但没有会话（只勾项目的配对）', { status: 'connected' as const, sessionId: null }, false],
    ['有会话但没连上', { status: 'offline' as const, sessionId: 's1' }, false],
    ['未配对', { status: 'unpaired' as const, sessionId: null }, false],
  ])('%s', (_label, state, expected) => {
    expect(canAddressSession(state)).toBe(expected);
  });
});
