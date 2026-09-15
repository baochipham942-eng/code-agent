import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage';
import type { PlatformPorts } from './ports';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import { isPrivateIPv4, validateLanEndpoint } from '../../../../src/shared/companion/lanProtocol';
import { classifyHttpFailure } from './httpFailure';
import { LanDns } from './lanDns';

const STATE_KEY = 'neo.companion.state.v1';
const INSTALL_KEY = 'neo.companion.install.v1';
let initialization: Promise<void> | null = null;
/**
 * Pairing identity stays in Keychain (`whenUnlockedThisDeviceOnly`).
 * Debug-iphonesimulator with Sign to Run Locally has no TeamIdentifier, so
 * SecItemAdd fails and the UI stays on storageError. Ad Hoc / Development
 * Team signed builds (ios:build / ios:verify require TeamIdentifier) write
 * successfully; that is the real-device path. Do not fall back to Preferences.
 */
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
      // 失败分类（fix4-②）：拒绝/超时/其余分三路上抛，store 再映射成用户可分辨的诊断。
    }).catch((error: unknown) => { throw new Error(classifyHttpFailure(error)); });
    if (response.url === url && response.status === 403 && target.pathname !== '/v1/exchange') throw new Error('COMPANION_PAIRING_REJECTED');
    if (response.status !== 200 || response.url !== url) throw new Error('COMPANION_NETWORK_UNAVAILABLE');
    return response.data as unknown;
  },
  resolveHost: async host => {
    // 只解析 .local 主机名：字面量 IP 没有可重解析的东西；返回地址必须是私网 IPv4
    // （与 validateLanEndpoint 同一口径），其余视为没解析到。
    if (!host.toLowerCase().endsWith('.local')) return null;
    try {
      const { address } = await LanDns.resolve({ host, timeoutMs: L.mdnsResolveTimeoutMs });
      return address && isPrivateIPv4(address) ? address : null;
    } catch { return null; }
  },
};
