import { describe, expect, it } from 'vitest';
import { canAddressSession, createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import { createNotificationStore } from '../../../packages/mobile/src/stores/notificationStore';
import { nativeTokenUnavailable } from '../../../packages/mobile/src/platform/notifications';
import type { NotificationPort, OsPermission, TokenResult } from '../../../packages/mobile/src/platform/ports';

function port(opts: { permission?: OsPermission; token?: TokenResult } = {}): NotificationPort & { setPermission(next: OsPermission): void } {
  let permission = opts.permission ?? 'unknown';
  return {
    permission: {
      read: async () => permission,
      request: async () => { permission = opts.permission === 'granted' ? 'granted' : (permission === 'unknown' ? 'denied' : permission); return permission; },
    },
    token: {
      current: async () => opts.token ?? { kind: 'token', token: { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' } },
      subscribe: () => () => {},
    },
    tap: { subscribe: async () => () => {} },
    openSettings: async () => {},
    network: { read: () => 'online' },
    setPermission(next: OsPermission) { permission = next; },
  };
}

describe('notificationStore', () => {
  it('keeps OS permission, preference, registration and network as separate fields', async () => {
    const notifications = createNotificationStore({
      port: port({ permission: 'denied' }),
      preference: { get: () => true, set: () => {} },
      session: { status: () => 'connected', register: async () => ({ kind: 'registered' }), unregister: async () => {}, openRoute: async () => {}, reconnect: async () => {} },
    });
    await notifications.getState().refresh();
    expect(notifications.getState()).toMatchObject({
      preference: true, osPermission: 'denied', registration: 'idle', network: 'online',
    });
    await notifications.getState().recover();
    expect(notifications.getState().osPermission).toBe('denied');
    expect(notifications.getState().registration).toBe('unregistered');
    expect(notifications.getState().network).toBe('online');
  });

  it('keeps the main companion session usable after notification permission is denied', async () => {
    const companion = createCompanionStore({
      read: async () => null, write: async () => {}, scan: async () => '', post: async () => ({}),
    }, () => {});
    companion.setState({ status: 'connected', sessionId: 'session-1', binding: { version: 1, endpoint: 'http://10.0.0.1:8182', hostKey: 'ab', deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'] } });
    const notifications = createNotificationStore({
      port: port({ permission: 'denied' }),
      preference: { get: () => true, set: () => {} },
      session: {
        status: () => companion.getState().status,
        register: async () => ({ kind: 'registered' }),
        unregister: async () => {},
        openRoute: async () => {},
        reconnect: async () => {},
      },
    });
    await notifications.getState().requestFromUser();
    expect(notifications.getState().osPermission).toBe('denied');
    expect(companion.getState().status).toBe('connected');
    expect(canAddressSession(companion.getState())).toBe(true);
  });

  it('restores registration after the OS permission is granted in settings', async () => {
    const native = port({ permission: 'denied' });
    const registered: unknown[] = [];
    const notifications = createNotificationStore({
      port: native,
      preference: { get: () => true, set: () => {} },
      session: {
        status: () => 'connected',
        register: async input => { registered.push(input); return { kind: 'registered' }; },
        unregister: async () => {},
        openRoute: async () => {},
        reconnect: async () => {},
      },
    });
    await notifications.getState().recover();
    expect(notifications.getState().registration).toBe('unregistered');
    native.setPermission('granted');
    await notifications.getState().recover();
    expect(notifications.getState().osPermission).toBe('granted');
    expect(notifications.getState().registration).toBe('registered');
    expect(registered).toEqual([{ provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' }]);
  });

  it('opens a route after auth and never auto-approves', async () => {
    const opened: string[] = [];
    const notifications = createNotificationStore({
      port: port({ permission: 'granted' }),
      preference: { get: () => true, set: () => {} },
      session: {
        status: () => 'connected',
        register: async () => ({ kind: 'registered' }),
        unregister: async () => {},
        openRoute: async token => { opened.push(token); },
        reconnect: async () => {},
      },
    });
    await notifications.getState().handleTap('opaque-route-token-1');
    expect(opened).toEqual(['opaque-route-token-1']);
  });

  it('requires an authenticated session before following a tap', async () => {
    const opened: string[] = [];
    const notifications = createNotificationStore({
      port: port(),
      preference: { get: () => true, set: () => {} },
      session: {
        status: () => 'offline',
        register: async () => ({ kind: 'rejected' }),
        unregister: async () => {},
        openRoute: async token => { opened.push(token); },
        reconnect: async () => {},
      },
    });
    await notifications.getState().handleTap('opaque-route-token-1');
    expect(notifications.getState().routeError).toBe('auth_required');
    expect(opened).toEqual([]);
  });

  it('records CHANNEL_MISSING instead of pretending FCM or APNs registered', async () => {
    const notifications = createNotificationStore({
      port: port({ permission: 'granted', token: nativeTokenUnavailable('android') }),
      preference: { get: () => true, set: () => {} },
      session: {
        status: () => 'connected',
        register: async () => ({ kind: 'registered' }),
        unregister: async () => {},
        openRoute: async () => {},
        reconnect: async () => {},
      },
    });
    await notifications.getState().recover();
    expect(notifications.getState().registration).toBe('failed');
    expect(notifications.getState().lastFailure).toBe('CHANNEL_MISSING:gms_or_vendor');
  });

  it('undoes a registration that lands after the user turned notifications off', async () => {
    let preference = true;
    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const unregistered: number[] = [];
    const notifications = createNotificationStore({
      port: port({ permission: 'granted' }),
      preference: { get: () => preference, set: value => { preference = value; } },
      session: {
        status: () => 'connected',
        register: async () => { await pending; return { kind: 'registered' }; },
        unregister: async () => { unregistered.push(1); },
        openRoute: async () => {},
        reconnect: async () => {},
      },
    });
    await notifications.getState().refresh();
    const registering = notifications.getState().setPreference(true);
    await notifications.getState().setPreference(false);
    release();
    await registering;
    expect(notifications.getState().registration).toBe('unregistered');
    expect(unregistered).toHaveLength(1);
  });
});
