import type { NotificationPort, TokenResult } from './ports';

/** Android this round has no GMS/vendor adapter. iOS without entitlement cannot mint a token. */
export function nativeTokenUnavailable(platform: string): TokenResult {
  return {
    kind: 'unavailable',
    code: 'CHANNEL_MISSING',
    missing: platform === 'android' ? 'gms_or_vendor' : 'apns_entitlement',
  };
}

export function createNotificationPort(platform: string, openSettings: () => Promise<void> = async () => {}): NotificationPort {
  return {
    permission: {
      read: async () => 'unknown',
      request: async () => (platform === 'ios' || platform === 'android' ? 'restricted' : 'denied'),
    },
    token: {
      current: async () => nativeTokenUnavailable(platform),
      subscribe: () => () => {},
    },
    tap: { subscribe: async () => () => {} },
    openSettings,
    network: { read: () => (typeof navigator === 'undefined' || navigator.onLine ? 'online' : 'offline') },
  };
}

export const unavailableNotificationPort: NotificationPort = createNotificationPort('web');
