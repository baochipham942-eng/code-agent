import { createStore } from 'zustand/vanilla';
import type { PlatformPorts } from '../platform/ports';

export type Appearance = 'system' | 'light' | 'dark';
export type SheetPage = 'settings' | 'appearance' | 'profile' | 'about' | 'help' | 'more' | 'model' | 'modelSetup' | 'projects' | 'projectSessions' | 'remote' | 'storage' | 'preview' | 'notifications' | 'attachment' | 'cameraDenied' | 'pairConfirm' | 'voiceSetup' | 'account';
type Route = 'new' | 'fixture';
type Preferences = { schema: 1; drafts: Record<string, string>; transcriptCommands?: Record<string, string>; appearance: Appearance; nickname: string; notifyEnabled: boolean;
  /** 新任务项目选择器上手选过的项目，按电脑（hostKey）记（N-MOBILE-DEFAULT-PROJECT）。 */
  projectPicks?: Record<string, string>;
  /** 上次打开的会话，按电脑（hostKey）记。空串 = 欢迎页（N-MOBILE-RESUME-LAST-SESSION）。 */
  lastSessions?: Record<string, string>;
  /** 上次见到的会话标题（`${hostKey}:${sessionId}` → title）：冷启动宿主停机时，缓存会话的标题从这里取（O1）。 */
  sessionTitles?: Record<string, string> };
type Sheet = { origin: 'root' | 'drawer'; pages: SheetPage[] };
interface State {
  preferences: Preferences; ready: boolean; loadError: boolean; saveError: boolean; saving: boolean;
  draftKey: string; activateDraft(key: string): void;
  route: Route; drawer: boolean; sheet: Sheet | null; profileDraft: string; sendAttempted: boolean;
  hydrate(): Promise<void>; editDraft(value: string): void; setAppearance(value: Appearance): void;
  setNotifyEnabled(value: boolean): void;
  pickProject(hostKey: string, projectId: string): void;
  rememberSession(hostKey: string, sessionId: string | null): void;
  rememberSessionTitle(hostKey: string, sessionId: string, title: string): void;
  /** 会话删除清一条（带 sessionId）、配对撤销/忘掉电脑清整台的标题记忆。 */
  forgetSessionTitles(hostKey: string, sessionId?: string): void;
  editProfile(value: string): void; saveProfile(): void; flush(): Promise<void>;
  openDrawer(): void; closeDrawer(): void; navigate(route: Route): void;
  openSheet(page: SheetPage): void; pushSheet(page: SheetPage): void; closeSheet(): void; back(): boolean;
  attemptSend(): void;
  /** continuation = 同一次录音的后续分片，接着上一段写，不另起一行。 */
  appendTranscript(text: string, key: string, commandId: string, continuation?: boolean): Promise<void>;
  acknowledgeDraft(text: string, key?: string): Promise<void>;
}
const defaults = (): Preferences => ({ schema: 1, drafts: { new: '', fixture: '' }, appearance: 'system', nickname: '', notifyEnabled: false });

/** sessionTitles 每台电脑最多记多少条：按写入先后淘汰最旧的，偏好盘不随历史会话数无限增长（ai-review Nit）。 */
const SESSION_TITLES_PER_HOST = 50;

/** 键序即写入先后（旧→新）：超出上限的电脑丢最旧的条目。调用方须先删后放，改写才算最新一次写入。 */
function capSessionTitles(titles: Record<string, string>): Record<string, string> {
  const queues = new Map<string, string[]>();
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(titles)) {
    const host = key.slice(0, key.indexOf(':'));
    const queue = queues.get(host) ?? [];
    queue.push(key);
    queues.set(host, queue);
    next[key] = value;
    if (queue.length > SESSION_TITLES_PER_HOST) delete next[queue.shift()!];
  }
  return next;
}
function decode(raw: string | null): Preferences {
  if (raw === null) return defaults();
  const p: unknown = JSON.parse(raw);
  if (!p || typeof p !== 'object') throw new Error('INVALID_PREFERENCES');
  const v = p as Partial<Preferences>;
  if (v.schema !== 1 || !v.drafts || typeof v.drafts.new !== 'string' || typeof v.drafts.fixture !== 'string' ||
      !['system', 'light', 'dark'].includes(v.appearance ?? '') || typeof v.nickname !== 'string') {
    throw new Error('INVALID_PREFERENCES');
  }
  return { schema: 1, transcriptCommands: v.transcriptCommands ?? {}, drafts: Object.fromEntries(Object.entries(v.drafts).filter(([, value]) => typeof value === 'string')), appearance: v.appearance!, nickname: v.nickname, notifyEnabled: v.notifyEnabled === true,
    projectPicks: Object.fromEntries(Object.entries(v.projectPicks ?? {}).filter(([, value]) => typeof value === 'string')),
    lastSessions: Object.fromEntries(Object.entries(v.lastSessions ?? {}).filter(([, value]) => typeof value === 'string')),
    sessionTitles: capSessionTitles(Object.fromEntries(Object.entries(v.sessionTitles ?? {}).filter(([, value]) => typeof value === 'string'))) };
}

/**
 * 转写文字并进草稿。整段转写（或一次录音的第一段）另起一行，与用户已经打的字分开；
 * 同一次录音的后续分片接着上一段写——分片是我们自己切的，不该在用户的句子里插换行。
 * 中日韩字符相接不补空格，拉丁文补一个，免得把两个词粘成一个。
 */
export function joinTranscript(draft: string, text: string, continuation: boolean): string {
  if (!draft) return text;
  if (!text) return draft;
  if (!continuation) return `${draft}\n${text}`;
  // 假名、韩文音节、CJK 兼容区都要算进来：漏了就会在日韩分片之间多一个空格。
  const cjk = /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
  return cjk.test(draft.at(-1)!) || cjk.test(text[0]) ? draft + text : `${draft} ${text}`;
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
      pickProject: (hostKey, projectId) => {
        if (!get().ready) return;
        set({ preferences: { ...get().preferences, projectPicks: { ...get().preferences.projectPicks, [hostKey]: projectId } } }); persist();
      },
      // lastSessions 有两个写入口（ai-review Nit，刻意保留）：这一处管 store 内部的时点
      // （配对成功/撤销/会话消失时 companionStore 传来的 remember(null)），MobileRoot 的
      // effect 管跟随渲染生命周期的同步——收成一处就得把渲染周期引进 store，不值。
      rememberSession: (hostKey, sessionId) => {
        if (!get().ready) return;
        set({ preferences: { ...get().preferences, lastSessions: { ...get().preferences.lastSessions, [hostKey]: sessionId ?? '' } } }); persist();
      },
      rememberSessionTitle: (hostKey, sessionId, title) => {
        if (!get().ready) return;
        const key = `${hostKey}:${sessionId}`;
        // 没变不写盘：库每次刷新都会走这里，照写会让偏好盘跟着每次 sync 抖动。
        if (get().preferences.sessionTitles?.[key] === title) return;
        // 改写也算最新一次写入：先删再放，让这条排到该电脑的最新端，淘汰只动最旧的。
        const stamped: Record<string, string> = { ...get().preferences.sessionTitles };
        delete stamped[key];
        stamped[key] = title;
        set({ preferences: { ...get().preferences, sessionTitles: capSessionTitles(stamped) } }); persist();
      },
      forgetSessionTitles: (hostKey, sessionId) => {
        if (!get().ready) return;
        const titles = get().preferences.sessionTitles ?? {};
        const exact = sessionId === undefined ? null : `${hostKey}:${sessionId}`;
        const drop = exact === null
          ? Object.keys(titles).filter(key => key.startsWith(`${hostKey}:`))
          : exact in titles ? [exact] : [];
        if (!drop.length) return;   // 没得清不写盘
        const next = { ...titles };
        for (const key of drop) delete next[key];
        set({ preferences: { ...get().preferences, sessionTitles: next } }); persist();
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
      appendTranscript: async (text, key, commandId, continuation = false) => {
        const { preferences } = get();
        if (!get().ready) throw new Error('COMPANION_DRAFT_NOT_READY');
        if (preferences.transcriptCommands?.[key] !== commandId) {
          set({ preferences: { ...preferences, drafts: { ...preferences.drafts, [key]: joinTranscript(preferences.drafts[key] ?? '', text, continuation) },
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
