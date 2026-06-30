import type { AppSettings } from '../../../shared/contract';
import { getSecureStorage } from '../core/secureStorage';
import { assertSafeCustomBaseUrl } from '../../security/ssrfGuard';

export interface BridgedEndpoint { baseUrl: string; apiKey: string; }

/** 按源 provider 从 settings 取 baseUrl + 从 SecureStorage 取 key，过 SSRF 守卫。key 不出 host。 */
export function resolveBridgedEndpoint(sourceProvider: string, settings: AppSettings | null): BridgedEndpoint {
  const cfg = settings?.models?.providers?.[sourceProvider];
  const rawBase = cfg?.baseUrl?.trim();
  if (!rawBase) throw new Error(`桥接模型源 provider ${sourceProvider} 未配置 baseUrl`);
  const baseUrl = assertSafeCustomBaseUrl(rawBase);
  let apiKey = '';
  try { apiKey = getSecureStorage().getApiKey(sourceProvider) || ''; } catch { apiKey = ''; }
  if (!apiKey) throw new Error(`桥接模型源 provider ${sourceProvider} 未配置 API Key，请在设置中补填。`);
  return { baseUrl, apiKey };
}
