import { createStore } from 'zustand/vanilla';
import type { NetworkStatus, NotificationPort, OsPermission, PushToken, TokenResult } from '../platform/ports';

export type RegistrationStatus = 'idle' | 'registering' | 'registered' | 'unregistered' | 'failed';

export interface NotificationSession {
  status(): 'unpaired' | 'connecting' | 'connected' | 'offline' | 'storageError' | 'rejected';
  register(input: PushToken): Promise<{ kind: string }>;
  unregister(): Promise<void>;
  openRoute(routeToken: string): Promise<void>;
  reconnect(): Promise<void>;
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
      if (token.kind === 'unavailable') {
        set({ registration: 'failed', lastFailure: `${token.code}:${token.missing}` });
        return;
      }
      if (deps.session.status() !== 'connected') {
        set({ registration: 'unregistered' });
        return;
      }
      set({ registration: 'registering', lastFailure: null });
      const result = await deps.session.register(token.token);
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
    };
  });
  deps.port.token.subscribe((result: TokenResult) => {
    if (result.kind === 'token' && store.getState().preference) void store.getState().recover();
  });
  return store;
}
