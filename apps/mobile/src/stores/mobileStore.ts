import { createStore } from 'zustand/vanilla';
import type { PlatformPorts } from '../platform/ports';

export type Appearance = 'system' | 'light' | 'dark';
export type SheetPage = 'settings' | 'appearance' | 'profile' | 'about' | 'help' | 'more' | 'projects' | 'remote';
type Route = 'new' | 'fixture';
type Preferences = { schema: 1; drafts: Record<Route, string>; appearance: Appearance; nickname: string };
type Sheet = { origin: 'root' | 'drawer'; pages: SheetPage[] };
interface State {
  preferences: Preferences; ready: boolean; loadError: boolean; saveError: boolean; saving: boolean;
  route: Route; drawer: boolean; sheet: Sheet | null; profileDraft: string; sendAttempted: boolean;
  hydrate(): Promise<void>; editDraft(value: string): void; setAppearance(value: Appearance): void;
  editProfile(value: string): void; saveProfile(): void; flush(): Promise<void>;
  openDrawer(): void; closeDrawer(): void; navigate(route: Route): void;
  openSheet(page: SheetPage): void; pushSheet(page: SheetPage): void; closeSheet(): void; back(): boolean;
  attemptSend(): void;
}
const defaults = (): Preferences => ({ schema: 1, drafts: { new: '', fixture: '' }, appearance: 'system', nickname: '' });
function decode(raw: string | null): Preferences {
  if (raw === null) return defaults();
  const p: unknown = JSON.parse(raw);
  if (!p || typeof p !== 'object') throw new Error('INVALID_PREFERENCES');
  const v = p as Partial<Preferences>;
  if (v.schema !== 1 || !v.drafts || typeof v.drafts.new !== 'string' || typeof v.drafts.fixture !== 'string' ||
      !['system', 'light', 'dark'].includes(v.appearance ?? '') || typeof v.nickname !== 'string') {
    throw new Error('INVALID_PREFERENCES');
  }
  return { schema: 1, drafts: { new: v.drafts.new, fixture: v.drafts.fixture }, appearance: v.appearance!, nickname: v.nickname };
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
        const { preferences, route } = get();
        set({ preferences: { ...preferences, drafts: { ...preferences.drafts, [route]: value } }, sendAttempted: false });
        persist();
      },
      setAppearance: appearance => {
        if (!get().ready) return;
        set({ preferences: { ...get().preferences, appearance } }); persist();
      },
      editProfile: profileDraft => set({ profileDraft }),
      saveProfile: () => {
        if (!get().ready || !get().profileDraft.trim()) return;
        set({ preferences: { ...get().preferences, nickname: get().profileDraft.trim() } }); persist(); get().back();
      },
      flush: async () => { if (get().ready && get().saveError) persist(); await pending; },
      openDrawer: () => { if (!get().sheet) set({ drawer: true }); },
      closeDrawer: () => set({ drawer: false }),
      navigate: route => set({ route, drawer: false, sheet: null, sendAttempted: false }),
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
      attemptSend: () => { if (get().ready && get().preferences.drafts[get().route].trim()) set({ sendAttempted: true }); },
    };
  });
  return store;
}
