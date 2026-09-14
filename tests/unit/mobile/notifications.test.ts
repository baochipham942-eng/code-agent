import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNotificationPort, nativeTokenUnavailable } from '../../../packages/mobile/src/platform/notifications';
import { unlinkedSpmPlugins } from '../../../packages/mobile/scripts/ios-package.mjs';

function fakeBridge(receive = 'prompt') {
  let permission = receive;
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    checkPermissions: vi.fn(async () => ({ receive: permission })),
    requestPermissions: vi.fn(async () => ({ receive: permission })),
    register: vi.fn(async () => {}),
    addListener: vi.fn(async (event: string, cb: (payload: unknown) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(cb);
      listeners.set(event, bucket);
      return { remove: async () => { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== cb)); } };
    }),
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    setReceive(next: string) { permission = next; },
  };
}

describe('createNotificationPort iOS plugin events', () => {
  it('registers after permission is granted and uploads the APNs token', async () => {
    const bridge = fakeBridge('granted');
    const port = createNotificationPort('ios', async () => {}, bridge);
    const seen: unknown[] = [];
    port.token.subscribe(result => { seen.push(result); });

    await expect(port.permission.request()).resolves.toBe('granted');
    expect(bridge.register).toHaveBeenCalledTimes(1);

    const pending = port.token.current();
    bridge.emit('registration', { value: 'device-token-aaaaaaaa' });
    await expect(pending).resolves.toEqual({
      kind: 'token',
      token: { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' },
    });
    expect(seen).toEqual([{
      kind: 'token',
      token: { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' },
    }]);
  });

  it('puts registrationError into the error state instead of staying silent', async () => {
    const bridge = fakeBridge('granted');
    const port = createNotificationPort('ios', async () => {}, bridge);
    await port.permission.read();
    const seen: unknown[] = [];
    port.token.subscribe(result => { seen.push(result); });
    const pending = port.token.current();
    bridge.emit('registrationError', { error: 'APNS_FAILED' });
    await expect(pending).resolves.toEqual({ kind: 'error', code: 'REGISTRATION_FAILED' });
    expect(seen).toEqual([{ kind: 'error', code: 'REGISTRATION_FAILED' }]);
  });

  it('does not call register when the user denies permission', async () => {
    const bridge = fakeBridge('denied');
    const port = createNotificationPort('ios', async () => {}, bridge);
    await expect(port.permission.request()).resolves.toBe('denied');
    expect(bridge.register).not.toHaveBeenCalled();
  });

  it('re-emits a refreshed token so the store can upload again', async () => {
    const bridge = fakeBridge('granted');
    const port = createNotificationPort('ios', async () => {}, bridge);
    await port.permission.read();
    const seen: string[] = [];
    port.token.subscribe(result => {
      if (result.kind === 'token') seen.push(result.token.token);
    });
    const first = port.token.current();
    bridge.emit('registration', { value: 'device-token-aaaaaaaa' });
    await first;
    bridge.emit('registration', { value: 'device-token-bbbbbbbb' });
    await expect(port.token.current()).resolves.toMatchObject({
      token: { token: 'device-token-bbbbbbbb' },
    });
    expect(seen).toEqual(['device-token-aaaaaaaa', 'device-token-bbbbbbbb']);
  });

  it('routes a tap through the existing routeToken without inventing a second channel', async () => {
    const bridge = fakeBridge('granted');
    const port = createNotificationPort('ios', async () => {}, bridge);
    const opened: string[] = [];
    await port.tap.subscribe(token => { opened.push(token); });
    bridge.emit('pushNotificationActionPerformed', {
      notification: { data: { titleKey: 'task_complete', kind: 'agent_complete', routeToken: 'opaque-route-token-1' } },
    });
    expect(opened).toEqual(['opaque-route-token-1']);
  });
});

describe('createNotificationPort Android honesty', () => {
  it('keeps nativeTokenUnavailable and never talks to the push plugin', async () => {
    const bridge = fakeBridge('granted');
    const port = createNotificationPort('android', async () => {}, bridge);
    expect(await port.token.current()).toEqual(nativeTokenUnavailable('android'));
    expect(await port.permission.request()).toBe('granted');
    expect(bridge.register).not.toHaveBeenCalled();
    expect(bridge.addListener).not.toHaveBeenCalled();
    expect(nativeTokenUnavailable('android')).toEqual({
      kind: 'unavailable',
      code: 'CHANNEL_MISSING',
      missing: 'gms_or_vendor',
    });
  });
});

describe('iOS build gate covers @capacitor/push-notifications', () => {
  const pkg = JSON.parse(readFileSync('packages/mobile/package.json', 'utf8')) as { dependencies: Record<string, string> };
  const buildScript = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');
  const capacitorPort = readFileSync('packages/mobile/src/platform/capacitor.ts', 'utf8');

  it('pins a concrete Capacitor 8 push-notifications version', () => {
    expect(pkg.dependencies['@capacitor/push-notifications']).toBe('8.1.2');
  });

  it('fails the iOS build when Package.swift omitted the installed push plugin', () => {
    const packageSwift = `.package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")`;
    expect(unlinkedSpmPlugins(packageSwift, ['@capacitor/app', '@capacitor/push-notifications']))
      .toEqual(['@capacitor/push-notifications']);
    expect(buildScript).toContain('installedIosPlugins()');
    expect(buildScript).toContain('IOS_PLUGINS_NOT_LINKED');
    expect(buildScript).toContain('withPushAppDelegateHooks');
    expect(buildScript).toContain('IOS_PUSH_PLUGIN_MISSING_FROM_BINARY');
    expect(buildScript).toContain('ensureAppPushEntitlements');
    expect(buildScript).toContain('assertBinaryPushEntitlement');
  });

  it('wires the official plugin only on iOS and does not call it on Android', () => {
    expect(capacitorPort).toContain("import { PushNotifications } from '@capacitor/push-notifications'");
    expect(capacitorPort).toContain("Capacitor.getPlatform() === 'ios' ? PushNotifications : undefined");
  });
});
