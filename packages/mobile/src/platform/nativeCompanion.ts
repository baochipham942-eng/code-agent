import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage';
import type { PlatformPorts } from './ports';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import { validateLanEndpoint } from '../../../../src/shared/companion/lanProtocol';

const STATE_KEY = 'neo.companion.state.v1';
const INSTALL_KEY = 'neo.companion.install.v1';
let initialization: Promise<void> | null = null;
const initialize = () => initialization ??= (async () => {
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
  // Keychain survives iOS uninstall; the app-owned marker does not.
  if (!(await Preferences.get({ key: INSTALL_KEY })).value) {
    await SecureStorage.remove(STATE_KEY, false);
    await Preferences.set({ key: INSTALL_KEY, value: crypto.randomUUID() });
  }
})().catch(error => { initialization = null; throw error; });

export const nativeCompanionPort: NonNullable<PlatformPorts['companion']> = {
  read: async () => { await initialize(); return await SecureStorage.get(STATE_KEY, false, false) as string | null; },
  write: async value => { await initialize(); await SecureStorage.set(STATE_KEY, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly); },
  scan: async () => (await (await import('@capacitor/barcode-scanner')).CapacitorBarcodeScanner.scanBarcode({ hint: 0 })).ScanResult,
  post: async (url, body) => {
    const target = new URL(url); validateLanEndpoint(target.origin);
    if (!['/v1/hello', '/v1/finish', '/v1/exchange'].includes(target.pathname) || target.search || target.hash || target.username || target.password) throw new Error('COMPANION_INVALID_LAN_ENDPOINT');
    const response = await CapacitorHttp.post({ url, headers: { 'content-type': 'application/json' }, data: body,
      disableRedirects: true, connectTimeout: L.requestTimeoutMs, readTimeout: L.requestTimeoutMs, responseType: 'json',
    });
    if (response.status !== 200 || response.url !== url) throw new Error('COMPANION_NETWORK_UNAVAILABLE');
    return response.data as unknown;
  },
};
