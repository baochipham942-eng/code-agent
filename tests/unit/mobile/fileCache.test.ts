import { describe, expect, it } from 'vitest';
import { FileCache } from '../../../packages/mobile/src/platform/fileCache';
import { createMobileStore } from '../../../packages/mobile/src/stores/mobileStore';
import { companionAckMatches, createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';


function disk(initial: string | null = null) {
  let value = initial;
  return { get: async () => value, set: async (next: string) => { value = next; }, snapshot: () => value };
}

describe('mobile file cache quota and cleanup', () => {
  it('evicts older rebuildable copies and refuses a single object over quota', () => {
    const cache = new FileCache(8, () => 1);
    cache.put('a', { name: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    cache.put('b', { name: 'b.txt', mimeType: 'text/plain', bytes: new Uint8Array([6, 7, 8, 9, 10]) });
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')?.bytes).toEqual(new Uint8Array([6, 7, 8, 9, 10]));
    expect(() => new FileCache(4).put('c', { name: 'c.txt', mimeType: 'text/plain', bytes: new Uint8Array([1, 2, 3, 4, 5]) })).toThrow('STORAGE_FULL');
  });

  it('clearing cache keeps drafts, pairing identity and settings', async () => {
    const prefs = disk();
    const identity = disk();
    let identityWrites = 0;
    const mobile = createMobileStore(prefs);
    await mobile.getState().hydrate();
    mobile.getState().editDraft('keep-this-draft');
    mobile.getState().setAppearance('dark');
    await mobile.getState().flush();
    const cache = new FileCache(1024);
    cache.put('preview', { name: 'shot.png', mimeType: 'image/png', bytes: new Uint8Array([9, 9]) });
    const companion = createCompanionStore({
      read: () => identity.get(),
      write: async value => { identityWrites += 1; await identity.set(value); },
      scan: async () => '',
      post: async () => ({}),
    }, () => {}, undefined, {
      cache,
      pick: async () => null,
      save: async () => { throw new Error('must-not-save-silently'); },
    });
    expect(cache.inspect().previewBytes).toBe(2);
    const usage = companion.getState().clearCache();
    // previewBytes 报告本次释放的预览字节（放入过 2 字节的预览副本）
    expect(usage.previewBytes).toBe(2);
    expect(cache.get('preview')).toBeNull();
    expect(identityWrites).toBe(0);
    expect(JSON.parse((await prefs.get())!).drafts.new).toBe('keep-this-draft');
    expect(JSON.parse((await prefs.get())!).appearance).toBe('dark');
    expect(await identity.get()).toBe(null);
  });

  it('preview save is explicit and a mismatched receipt cannot settle a file command', async () => {
    const cache = new FileCache(1024);
    let saved = 0;
    const companion = createCompanionStore({
      read: async () => null, write: async () => {}, scan: async () => '', post: async () => ({}),
    }, () => {}, undefined, {
      cache,
      pick: async () => null,
      save: async () => { saved += 1; return { status: 'saved' }; },
    });
    expect(companion.getState().preview).toBeNull();
    expect(saved).toBe(0);
    await companion.getState().savePreview();
    companion.getState().closePreview();
    expect(saved).toBe(0);
    const pending = { commandId: 'cmd-1', deviceId: 'phone-1', sessionId: 'session-1', action: 'files.commit' as const };
    expect(companionAckMatches(pending, { ...pending, commandId: 'other' })).toBe(false);
    expect(companionAckMatches(pending, pending)).toBe(true);
  });
});
