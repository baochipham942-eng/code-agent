import type { ForegroundPushDecision, NotificationPort, OsPermission, TokenResult } from './ports';

type ListenerHandle = { remove: () => Promise<void> };

/** Subset of @capacitor/push-notifications used by the iOS token/tap port. Injected so tests never load the plugin. */
interface PushNotificationBridge {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: 'registration', cb: (token: { value: string }) => void): Promise<ListenerHandle>;
  addListener(event: 'registrationError', cb: (error: { error: string }) => void): Promise<ListenerHandle>;
  addListener(
    event: 'pushNotificationActionPerformed',
    cb: (action: { notification: { data?: Record<string, unknown> } }) => void,
  ): Promise<ListenerHandle>;
}

/**
 * 第一方 iOS 插件（ios-native/NeoPushPresentationPlugin.swift）：前台来推送时先发 willPresent 问 JS，
 * JS 用 decide 回话 present（横幅）/ list（通知中心列表）两位。插件那头有超时兜底，JS 回不了话就照常弹。
 */
export interface PushPresentationBridge {
  enable(): Promise<void>;
  decide(options: { id: string } & ForegroundPushDecision): Promise<void>;
  addListener(event: 'willPresent', cb: (event: { id: string; routeToken?: string }) => void): Promise<ListenerHandle>;
}

/** Android has no GMS/vendor adapter this round; do not invent an FCM token. */
export function nativeTokenUnavailable(platform: string): TokenResult {
  return {
    kind: 'unavailable',
    code: 'CHANNEL_MISSING',
    missing: platform === 'android' ? 'gms_or_vendor' : 'apns_entitlement',
  };
}

function mapReceive(receive: string): OsPermission {
  if (receive === 'granted' || receive === 'limited' || receive === 'denied' || receive === 'restricted') return receive;
  return 'unknown';
}

function routeTokenFromData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const token = (data as { routeToken?: unknown }).routeToken;
  return typeof token === 'string' && token.trim().length > 0 ? token : null;
}

function networkStatus(): NotificationPort['network'] {
  return { read: () => (typeof navigator === 'undefined' || navigator.onLine ? 'online' : 'offline') };
}

/**
 * Ad Hoc / Release IPA talks to production APNs. register() resolves before the token
 * arrives; wait for `registration` / `registrationError` instead of treating resolve as success.
 */
const TOKEN_WAIT_MS = 10_000;

export function createNotificationPort(
  platform: string,
  openSettings: () => Promise<void> = async () => {},
  bridge?: PushNotificationBridge,
  presentation?: PushPresentationBridge,
): NotificationPort {
  // Android: no GMS/vendor channel. Never call the push plugin (register() would look
  // like FCM exists). Report granted so the store can surface CHANNEL_MISSING rather
  // than pretending the user denied alerts. iOS without a bridge stays fail-closed.
  if (platform !== 'ios' || !bridge) {
    const android = platform === 'android';
    return {
      permission: {
        read: async () => (android ? 'granted' : 'unknown'),
        request: async () => (android ? 'granted' : platform === 'ios' ? 'restricted' : 'denied'),
      },
      token: {
        current: async () => nativeTokenUnavailable(platform),
        subscribe: () => () => {},
      },
      tap: { subscribe: async () => () => {} },
      openSettings,
      network: networkStatus(),
    };
  }

  let latest: TokenResult | null = null;
  const tokenListeners = new Set<(result: TokenResult) => void>();
  const tapListeners = new Set<(route: string) => void>();
  const tokenWaiters: Array<(result: TokenResult) => void> = [];
  let pendingTap: string | null = null;
  let registerInFlight: Promise<void> | null = null;

  const publishToken = (result: TokenResult) => {
    latest = result;
    while (tokenWaiters.length > 0) tokenWaiters.shift()?.(result);
    for (const listener of tokenListeners) listener(result);
  };

  const publishTap = (route: string) => {
    if (tapListeners.size === 0) {
      pendingTap = route;
      return;
    }
    for (const listener of tapListeners) listener(route);
  };

  const ready = (async () => {
    const handles: ListenerHandle[] = [];
    handles.push(await bridge.addListener('registration', ({ value }) => {
      publishToken({
        kind: 'token',
        token: { provider: 'apns', token: value, environment: 'production' },
      });
    }));
    try {
      handles.push(await bridge.addListener('registrationError', () => {
        publishToken({ kind: 'error', code: 'REGISTRATION_FAILED' });
      }));
      handles.push(await bridge.addListener('pushNotificationActionPerformed', action => {
        const route = routeTokenFromData(action.notification.data);
        if (route) publishTap(route);
      }));
    } catch (error) {
      await Promise.all(handles.map(handle => handle.remove()));
      throw error;
    }
  })().catch(() => {
    publishToken({ kind: 'error', code: 'REGISTRATION_FAILED' });
  });

  const waitForToken = () => {
    if (latest) return Promise.resolve(latest);
    return new Promise<TokenResult>(resolve => {
      const timer = setTimeout(() => {
        if (latest) {
          resolve(latest);
          return;
        }
        publishToken({ kind: 'error', code: 'REGISTRATION_FAILED' });
      }, TOKEN_WAIT_MS);
      tokenWaiters.push(result => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  };

  const ensureRegistered = async () => {
    await ready;
    if (latest?.kind === 'token') return;
    if (!registerInFlight) {
      registerInFlight = bridge.register()
        .catch(() => { publishToken({ kind: 'error', code: 'REGISTRATION_FAILED' }); })
        .finally(() => { registerInFlight = null; });
    }
    await registerInFlight;
  };

  return {
    permission: {
      read: async () => {
        await ready;
        return mapReceive((await bridge.checkPermissions()).receive);
      },
      request: async () => {
        await ready;
        const permission = mapReceive((await bridge.requestPermissions()).receive);
        if (permission === 'granted' || permission === 'limited') void ensureRegistered();
        return permission;
      },
    },
    token: {
      current: () => {
        if (latest?.kind === 'token') return Promise.resolve(latest);
        const pending = waitForToken();
        void ensureRegistered();
        return pending;
      },
      subscribe: onChange => {
        tokenListeners.add(onChange);
        return () => { tokenListeners.delete(onChange); };
      },
    },
    tap: {
      subscribe: async onTap => {
        await ready;
        tapListeners.add(onTap);
        if (pendingTap) {
          const route = pendingTap;
          pendingTap = null;
          onTap(route);
        }
        return () => { tapListeners.delete(onTap); };
      },
    },
    ...(presentation ? {
      foreground: {
        subscribe: async (decide: (routeToken: string | null) => Promise<ForegroundPushDecision>) => {
          const handle = await presentation.addListener('willPresent', ({ id, routeToken }) => {
            void decide(typeof routeToken === 'string' && routeToken ? routeToken : null)
              .catch(() => ({ present: true, list: true }) as ForegroundPushDecision)
              .then(({ present, list }) => presentation.decide({ id, present, list }))
              .catch(() => {});
          });
          // 旧包里没有这个插件：退回「前台照常弹」，不当成原生错误（那会把整页标成系统交互不可用）。
          try { await presentation.enable(); } catch { await handle.remove(); return () => {}; }
          return () => { void handle.remove(); };
        },
      },
    } : {}),
    openSettings,
    network: networkStatus(),
  };
}

export const unavailableNotificationPort: NotificationPort = createNotificationPort('web');
