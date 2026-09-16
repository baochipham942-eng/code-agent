import { createStore } from 'zustand/vanilla';
import type { NetworkStatus, NotificationPort, OsPermission, PushToken, TokenResult } from '../platform/ports';

export type RegistrationStatus = 'idle' | 'registering' | 'registered' | 'unregistered' | 'failed';

export interface NotificationSession {
  status(): 'unpaired' | 'connecting' | 'connected' | 'offline' | 'storageError' | 'rejected';
  register(input: PushToken): Promise<{ kind: string }>;
  unregister(): Promise<void>;
  openRoute(routeToken: string): Promise<void>;
  reconnect(): Promise<void>;
  /** 用户此刻在前台正看着的会话；不在会话页（后台、抽屉/弹层盖着、没连着）时给 null。 */
  viewing?(): string | null;
  /** 推送属于哪条会话（只读查询，不跳转）；查不到给 null。 */
  resolveRoute?(routeToken: string): Promise<string | null>;
}

interface State {
  preference: boolean;
  osPermission: OsPermission;
  registration: RegistrationStatus;
  network: NetworkStatus;
  lastFailure: string | null;
  routeError: string | null;
  setPreference(value: boolean): Promise<void>;
  requestFromUser(): Promise<void>;
  refresh(): Promise<void>;
  recover(): Promise<void>;
  handleTap(routeToken: string): Promise<void>;
  /** 前台来了一条推送，要不要弹系统横幅（N-MOBILE-EXEC-STATUS ④）。 */
  decideForeground(routeToken: string | null): Promise<boolean>;
}

/**
 * OS permission, business preference, push registration, and network are stored
 * separately and must not stand in for each other.
 */
export function createNotificationStore(deps: {
  port: NotificationPort;
  preference: { get(): boolean; set(value: boolean): void };
  session: NotificationSession;
}) {
  const store = createStore<State>((set, get) => {
    const syncRegistration = async () => {
      const { preference, osPermission } = get();
      if (!preference) {
        if (get().registration === 'registered') await deps.session.unregister();
        set({ registration: 'unregistered', lastFailure: null });
        return;
      }
      if (osPermission !== 'granted' && osPermission !== 'limited') {
        set({ registration: 'unregistered' });
        return;
      }
      const token = await deps.port.token.current();
      if (token.kind !== 'token') {
        set({
          registration: 'failed',
          lastFailure: token.kind === 'unavailable' ? `${token.code}:${token.missing}` : token.code,
        });
        return;
      }
      if (deps.session.status() !== 'connected') {
        set({ registration: 'unregistered' });
        return;
      }
      set({ registration: 'registering', lastFailure: null });
      const result = await deps.session.register(token.token);
      // Switching the preference off mid-register sees 'registering', not 'registered', so that
      // path cannot unregister for us. Re-read it here or the Host keeps pushing to a phone that
      // has already turned notifications off.
      if (!get().preference) {
        if (result.kind === 'registered') await deps.session.unregister();
        set({ registration: 'unregistered', lastFailure: null });
        return;
      }
      set(result.kind === 'registered'
        ? { registration: 'registered', lastFailure: null }
        : { registration: 'failed', lastFailure: result.kind });
    };
    return {
      preference: deps.preference.get(),
      osPermission: 'unknown',
      registration: 'idle',
      network: deps.port.network.read(),
      lastFailure: null,
      routeError: null,
      setPreference: async value => {
        deps.preference.set(value);
        set({ preference: value });
        if (value && get().osPermission === 'unknown') await get().requestFromUser();
        await syncRegistration();
      },
      requestFromUser: async () => {
        set({ osPermission: 'requesting' });
        const osPermission = await deps.port.permission.request();
        set({ osPermission, network: deps.port.network.read() });
        await syncRegistration();
      },
      refresh: async () => {
        const osPermission = await deps.port.permission.read();
        set({ osPermission, network: deps.port.network.read(), preference: deps.preference.get() });
      },
      recover: async () => {
        await get().refresh();
        await syncRegistration();
      },
      handleTap: async routeToken => {
        set({ routeError: null });
        if (deps.session.status() !== 'connected') await deps.session.reconnect();
        if (deps.session.status() !== 'connected') {
          set({ routeError: 'auth_required' });
          return;
        }
        await deps.session.openRoute(routeToken);
        // Lock screen / notification tap must not approve. respond is never called here.
      },
      decideForeground: async routeToken => {
        // 只有「正看着的就是推送那条会话」才不弹：任务完成/失败、待确认都已在会话里就地出现。
        // 在别的会话、不在会话页、判不出推送属于哪条（没 token、查询失败/不支持）一律照弹——宁可多弹，不许吞。
        const viewing = deps.session.viewing?.() ?? null;
        if (!viewing || !routeToken || !deps.session.resolveRoute) return true;
        const target = await deps.session.resolveRoute(routeToken).catch(() => null);
        return target !== viewing;
      },
    };
  });
  deps.port.token.subscribe((result: TokenResult) => {
    if (!store.getState().preference) return;
    if (result.kind === 'token') {
      void store.getState().recover();
      return;
    }
    store.setState({
      registration: 'failed',
      lastFailure: result.kind === 'unavailable' ? `${result.code}:${result.missing}` : result.code,
    });
  });
  return store;
}
