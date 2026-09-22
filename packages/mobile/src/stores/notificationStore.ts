import { createStore } from 'zustand/vanilla';
import type { ForegroundPushDecision, NetworkStatus, NotificationPort, OsPermission, PushToken, TokenResult } from '../platform/ports';

export type RegistrationStatus = 'idle' | 'registering' | 'registered' | 'unregistered' | 'failed';

/**
 * 前台被吞的系统横幅的 app 内替身（N-MOBILE-FOREGROUND-PUSH）：会话区顶部轻提示 + 可点跳转。
 * routeToken 为 null 表示判不出归属（没 token / 查询失败 / relay / 离线），点按只收掉提示；
 * 有 token 时归属点按那刻现查（handleTap → openRoute），不在这条上预存。
 */
interface ForegroundAlert {
  routeToken: string | null;
  sessionId: string | null;
}

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
  /** 前台来推送时落下的轻提示；同刻只留最新一条（会被下一条顶掉——持久痕迹在系统通知中心，见 decideForeground 的 list）。 */
  foregroundAlert: ForegroundAlert | null;
  /** 前台被吞的横幅记下的未读会话（内存集合，不落盘——只补这一个信号缺口，进会话即清）。 */
  unreadSessions: string[];
  setPreference(value: boolean): Promise<void>;
  requestFromUser(): Promise<void>;
  refresh(): Promise<void>;
  recover(): Promise<void>;
  handleTap(routeToken: string): Promise<void>;
  /** 收掉前台轻提示（点按或到点自隐）。 */
  dismissForegroundAlert(): void;
  /** 进了这条会话，未读点随之清掉。 */
  markSessionRead(sessionId: string): void;
  /** 前台来了一条推送，系统层怎么呈现（横幅一律不弹；通知中心列表常开——N-MOBILE-FOREGROUND-PUSH-R3）。 */
  decideForeground(routeToken: string | null): Promise<ForegroundPushDecision>;
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
      foregroundAlert: null,
      unreadSessions: [],
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
        // N-MOBILE-FOREGROUND-PUSH-R3：前台一律不弹系统横幅（present=false），打扰换成 app 内提示——
        // 轻提示 + 抽屉未读点（下面两行 set），但给原生回 list=true：通知中心仍各落一条持久、可堆叠的
        // 记录。R2 的教训（R3 Important）：恒 false 后原生投空 options，判不出归属（relay/离线/查询失败）
        // 时替代信号全灭——未读点要 sessionId 才落得下去，轻提示又是单槽内存态（下一条一顶、杀 app 即
        // 没），第一条推送永久不可达。「不许吞」的最后落点必须在系统层；app 内提示只当一闪而过的指针。
        // 唯一两位全 false 的情形：正看着的就是推送那条会话（N-MOBILE-EXEC-STATUS ④）——任务完成/
        // 失败、待确认都已在会话里就地出现，横幅和列表记录都是重复打扰。
        // 归属查询只在会话页做（R3 Nit②）：这次 LAN 往返是为了判「正看着的就是这条」，必须等结果才能
        // 回话；不在会话页（欢迎页/抽屉/弹层盖着/离线）时它的唯一收益是提前给未读点上料，而 decide
        // 在这里多等一拍，慢网上就撞原生 1.5s 兜底——系统横幅照弹 + app 内提示同时出，双份打扰。
        // 归属挪到点按那刻现查（handleTap → openRoute），非会话页的未读缺口由通知中心 [.list] 记录兜住。
        let viewing: string | null = null;
        let target: string | null = null;
        try {
          viewing = deps.session.viewing?.() ?? null;
          if (viewing && routeToken && deps.session.resolveRoute) target = await deps.session.resolveRoute(routeToken).catch(() => null);
        } catch {
          // 判定自身不许抛：这里崩了只丢归属（target 留 null），轻提示照出；
          // notifications.ts 那头的 .catch(() => ({present:true,list:true})) 仍是「JS 真崩就照常弹」的最终垫底。
        }
        if (viewing && target === viewing) return { present: false, list: false };
        set(state => ({
          foregroundAlert: { routeToken, sessionId: target },
          unreadSessions: target && !state.unreadSessions.includes(target)
            ? [...state.unreadSessions, target]
            : state.unreadSessions,
        }));
        return { present: false, list: true };
      },
      dismissForegroundAlert: () => set({ foregroundAlert: null }),
      markSessionRead: sessionId => set(state => ({ unreadSessions: state.unreadSessions.filter(id => id !== sessionId) })),
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
