import { createStore } from 'zustand/vanilla';
import type { PlatformPorts } from '../platform/ports';

export type Appearance = 'system' | 'light' | 'dark';
export type SheetPage = 'settings' | 'appearance' | 'profile' | 'about' | 'help' | 'more' | 'projects' | 'remote' | 'storage' | 'preview' | 'notifications';
type Route = 'new' | 'fixture';
type Preferences = { schema: 1; drafts: Record<string, string>; transcriptCommands?: Record<string, string>; appearance: Appearance; nickname: string; notifyEnabled: boolean };
type Sheet = { origin: 'root' | 'drawer'; pages: SheetPage[] };
interface State {
  preferences: Preferences; ready: boolean; loadError: boolean; saveError: boolean; saving: boolean;
  draftKey: string; activateDraft(key: string): void;
  route: Route; drawer: boolean; sheet: Sheet | null; profileDraft: string; sendAttempted: boolean;
  hydrate(): Promise<void>; editDraft(value: string): void; setAppearance(value: Appearance): void;
  setNotifyEnabled(value: boolean): void;
  editProfile(value: string): void; saveProfile(): void; flush(): Promise<void>;
  openDrawer(): void; closeDrawer(): void; navigate(route: Route): void;
  openSheet(page: SheetPage): void; pushSheet(page: SheetPage): void; closeSheet(): void; back(): boolean;
  attemptSend(): void;
  appendTranscript(text: string, key: string, commandId: string): Promise<void>;
  acknowledgeDraft(text: string, key?: string): Promise<void>;
}
const defaults = (): Preferences => ({ schema: 1, drafts: { new: '', fixture: '' }, appearance: 'system', nickname: '', notifyEnabled: false });
function decode(raw: string | null): Preferences {
  if (raw === null) return defaults();
  const p: unknown = JSON.parse(raw);
  if (!p || typeof p !== 'object') throw new Error('INVALID_PREFERENCES');
  const v = p as Partial<Preferences>;
  if (v.schema !== 1 || !v.drafts || typeof v.drafts.new !== 'string' || typeof v.drafts.fixture !== 'string' ||
      !['system', 'light', 'dark'].includes(v.appearance ?? '') || typeof v.nickname !== 'string') {
    throw new Error('INVALID_PREFERENCES');
  }
  return { schema: 1, transcriptCommands: v.transcriptCommands ?? {}, drafts: Object.fromEntries(Object.entries(v.drafts).filter(([, value]) => typeof value === 'string')), appearance: v.appearance!, nickname: v.nickname, notifyEnabled: v.notifyEnabled === true };
}

export function createMobileStore(port: PlatformPorts['preferences']) {
  let pending: Promise<void> = Promise.resolve();
  let revision = 0;
  let hydrating: Promise<void> | null = null;
  const store = createStore<State>((set, get) => {
    const persist = () => {
      const value = JSON.stringify(get().preferences);
      const current = ++revision;
      set({ saving: true });
      pending = pending.then(async () => {
        try {
          await port.set(value);
          if (current === revision) set({ saveError: false, saving: false });
        } catch {
          if (current === revision) set({ saveError: true, saving: false });
        }
      });
    };
    return {
      preferences: defaults(), ready: false, loadError: false, saveError: false, saving: false,
      draftKey: 'new', activateDraft: key => {
        const { preferences } = get();
        // Preserve the build-15 unassigned draft on the first actual shared session.
        if (key !== 'new' && key !== 'fixture' && preferences.drafts[key] === undefined && preferences.drafts.new) {
          set({ preferences: { ...preferences, drafts: { ...preferences.drafts, [key]: preferences.drafts.new, new: '' } } }); persist();
        }
        set({ draftKey: key });
      },
      route: 'new', drawer: false, sheet: null, profileDraft: '', sendAttempted: false,
      hydrate: () => {
        if (get().ready) return Promise.resolve();
        if (hydrating) return hydrating;
        hydrating = (async () => {
          set({ loadError: false });
          try {
            const preferences = decode(await port.get());
            set({ preferences, profileDraft: preferences.nickname, ready: true });
          } catch { set({ loadError: true }); }
        })().finally(() => { hydrating = null; });
        return hydrating;
      },
      editDraft: value => {
        if (!get().ready) return;
        const { preferences, draftKey } = get();
        set({ preferences: { ...preferences, drafts: { ...preferences.drafts, [draftKey]: value } }, sendAttempted: false });
        persist();
      },
      setAppearance: appearance => {
        if (!get().ready) return;
        set({ preferences: { ...get().preferences, appearance } }); persist();
      },
      setNotifyEnabled: notifyEnabled => {
        if (!get().ready) return;
        set({ preferences: { ...get().preferences, notifyEnabled } }); persist();
      },
      editProfile: profileDraft => set({ profileDraft }),
      saveProfile: () => {
        if (!get().ready || !get().profileDraft.trim()) return;
        set({ preferences: { ...get().preferences, nickname: get().profileDraft.trim() } }); persist(); get().back();
      },
      flush: async () => { if (get().ready && get().saveError) persist(); await pending; },
      openDrawer: () => { if (!get().sheet) set({ drawer: true }); },
      closeDrawer: () => set({ drawer: false }),
      navigate: route => set({ route, ...(route === 'fixture' ? { draftKey: 'fixture' } : {}), drawer: false, sheet: null, sendAttempted: false }),
      openSheet: page => { if (!get().sheet) set({ sheet: { origin: get().drawer ? 'drawer' : 'root', pages: [page] } }); },
      pushSheet: page => {
        const sheet = get().sheet;
        if (sheet && sheet.pages.at(-1) !== page) set({ sheet: { ...sheet, pages: [...sheet.pages, page] } });
      },
      closeSheet: () => set({ sheet: null }),
      back: () => {
        const { sheet, drawer } = get();
        if (sheet) { set({ sheet: sheet.pages.length > 1 ? { ...sheet, pages: sheet.pages.slice(0, -1) } : null }); return true; }
        if (drawer) { set({ drawer: false }); return true; }
        return false;
      },
      attemptSend: () => { if (get().ready && (get().preferences.drafts[get().draftKey] ?? '').trim()) set({ sendAttempted: true }); },
      appendTranscript: async (text, key, commandId) => {
        const { preferences } = get();
        if (!get().ready) throw new Error('COMPANION_DRAFT_NOT_READY');
        if (preferences.transcriptCommands?.[key] !== commandId) {
          set({ preferences: { ...preferences, drafts: { ...preferences.drafts, [key]: [preferences.drafts[key], text].filter(Boolean).join('\n') },
            transcriptCommands: { ...preferences.transcriptCommands, [key]: commandId } } }); persist();
        } else if (get().saveError) persist();
        for (;;) { const tail = pending; await tail; if (tail === pending) break; }
        if (get().saveError) throw new Error('COMPANION_DRAFT_NOT_SAVED');
      },
      acknowledgeDraft: async (text, key = 'new') => {
        const { preferences } = get();
        if (!get().ready) throw new Error('COMPANION_DRAFT_NOT_READY');
        if (preferences.drafts[key] === undefined && key !== 'new' && preferences.drafts.new === text) {
          set({ preferences: { ...preferences, drafts: { ...preferences.drafts, new: '' } } }); persist();
        } else if (preferences.drafts[key] === text) {
          set({ preferences: { ...preferences, drafts: { ...preferences.drafts, [key]: '' } }, sendAttempted: false }); persist();
        } else if (get().saveError) persist();
        // Include edits queued while the acknowledgement write was in flight.
        for (;;) { const tail = pending; await tail; if (tail === pending) break; }
        if (get().saveError) throw new Error('COMPANION_DRAFT_NOT_SAVED');
      },
    };
  });
  return store;
}
