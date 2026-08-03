import WebSocket from 'ws';
import type {
  CustomRealtimeVoiceProviderSettings,
  VoiceLiveSettings,
} from '../../../shared/contract/settings';
import {
  createCustomRealtimeVoiceProfile,
  getBuiltInRealtimeVoiceProfile,
  resolveRealtimeVoiceProfile,
  type RealtimeVoiceProviderProfile,
} from '../../../shared/constants/realtimeVoiceProviders';
import { getHttpsAgent } from '../../model/providers/providerHttp';
import { assertSafeCustomWebSocketUrl } from '../../security/ssrfGuard';
import { redactSecrets } from '../../security/secretRedaction';
import { getConfigService } from '../core/configService';
import { getSecureStorage } from '../core/secureStorage';

const CUSTOM_PROVIDER_KEY_PREFIX = 'custom-realtime:';
const CUSTOM_PROVIDER_TEST_TIMEOUT_MS = 8_000;
const VALID_PROVIDER_ID = /^[a-z][a-z0-9-]{2,63}$/;
const RESERVED_PROVIDER_IDS = new Set(['dashscope-qwen-omni', 'openai-realtime', 'qwen-omni']);

export interface CustomRealtimeVoiceProviderInput {
  id: string;
  displayName: string;
  endpoint: string;
  authStyle: 'bearer' | 'other';
  sessionShape: 'openai-realtime' | 'other';
  model: string;
  voices: string[];
  defaultVoice?: string;
  inputSampleRate: 16_000 | 24_000;
}

export interface CustomRealtimeProviderTestResult {
  success: boolean;
  needsCodeAdaptation: boolean;
  error?: string;
}

function keySlot(id: string): string {
  return `${CUSTOM_PROVIDER_KEY_PREFIX}${id}`;
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVoices(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(normalizedString).filter(Boolean))).slice(0, 50);
}

export function normalizeCustomRealtimeProviderInput(
  input: CustomRealtimeVoiceProviderInput,
  previous?: CustomRealtimeVoiceProviderSettings,
): CustomRealtimeVoiceProviderSettings {
  const id = normalizedString(input.id).toLowerCase();
  if (!VALID_PROVIDER_ID.test(id) || RESERVED_PROVIDER_IDS.has(id)) {
    throw new Error('Provider ID 需为 3–64 位小写字母、数字或连字符，且不能使用内建 ID');
  }
  if (input.authStyle !== 'bearer' || input.sessionShape !== 'openai-realtime') {
    throw new Error('NEEDS_CODE_ADAPTATION');
  }
  const displayName = normalizedString(input.displayName);
  const model = normalizedString(input.model);
  const voices = normalizeVoices(input.voices);
  if (!displayName || !model || voices.length === 0) {
    throw new Error('Provider 名称、模型和至少一个音色不能为空');
  }
  const endpoint = assertSafeCustomWebSocketUrl(input.endpoint);
  const defaultVoice = normalizedString(input.defaultVoice);
  const now = Date.now();
  return {
    id,
    displayName,
    endpoint,
    authStyle: 'bearer',
    sessionShape: 'openai-realtime',
    model,
    voices,
    defaultVoice: voices.includes(defaultVoice) ? defaultVoice : voices[0],
    inputSampleRate: input.inputSampleRate === 16_000 ? 16_000 : 24_000,
    outputSampleRate: 24_000,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

function sanitizeStoredProvider(value: unknown): CustomRealtimeVoiceProviderSettings | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<CustomRealtimeVoiceProviderSettings>;
  try {
    const normalized = normalizeCustomRealtimeProviderInput({
      id: row.id ?? '',
      displayName: row.displayName ?? '',
      endpoint: row.endpoint ?? '',
      authStyle: row.authStyle ?? 'other',
      sessionShape: row.sessionShape ?? 'other',
      model: row.model ?? '',
      voices: row.voices ?? [],
      defaultVoice: row.defaultVoice,
      inputSampleRate: row.inputSampleRate === 16_000 ? 16_000 : 24_000,
    }, row as CustomRealtimeVoiceProviderSettings);
    return {
      ...normalized,
      createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
        ? row.createdAt
        : normalized.createdAt,
      updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
        ? row.updatedAt
        : normalized.updatedAt,
    };
  } catch {
    return null;
  }
}

export function listCustomRealtimeVoiceProviders(
  live: VoiceLiveSettings | undefined = getConfigService().getSettings().voice?.live,
): CustomRealtimeVoiceProviderSettings[] {
  return (live?.customProviders ?? [])
    .map(sanitizeStoredProvider)
    .filter((provider): provider is CustomRealtimeVoiceProviderSettings => provider !== null);
}

export function resolveConfiguredRealtimeVoiceProfile(
  providerId: unknown,
  live: VoiceLiveSettings | undefined = getConfigService().getSettings().voice?.live,
): RealtimeVoiceProviderProfile {
  const builtin = getBuiltInRealtimeVoiceProfile(providerId);
  if (builtin) return builtin;
  const custom = listCustomRealtimeVoiceProviders(live)
    .find((provider) => provider.id === providerId);
  return custom ? createCustomRealtimeVoiceProfile(custom) : resolveRealtimeVoiceProfile(undefined);
}

export function getRealtimeVoiceProviderApiKey(profile: RealtimeVoiceProviderProfile): string | undefined {
  if (profile.id === 'dashscope-qwen-omni') return undefined;
  if (profile.id === 'openai-realtime') return getConfigService().getApiKey('openai');
  try {
    return getSecureStorage().getApiKey(keySlot(profile.id)) || undefined;
  } catch {
    return undefined;
  }
}

export function hasCustomRealtimeVoiceProviderApiKey(id: string): boolean {
  try {
    return Boolean(getSecureStorage().getApiKey(keySlot(id)));
  } catch {
    return false;
  }
}

function safeProviderError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutExactKey = apiKey ? raw.split(apiKey).join('[secret hidden]') : raw;
  return redactSecrets(withoutExactKey);
}

export async function testCustomRealtimeVoiceProvider(
  input: CustomRealtimeVoiceProviderInput,
  apiKey: string,
): Promise<CustomRealtimeProviderTestResult> {
  if (input.authStyle !== 'bearer' || input.sessionShape !== 'openai-realtime') {
    return {
      success: false,
      needsCodeAdaptation: true,
      error: '该 Provider 的鉴权或事件协议需要代码适配',
    };
  }
  let provider: CustomRealtimeVoiceProviderSettings;
  try {
    provider = normalizeCustomRealtimeProviderInput(input);
  } catch (error) {
    return {
      success: false,
      needsCodeAdaptation: error instanceof Error && error.message === 'NEEDS_CODE_ADAPTATION',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const key = apiKey.trim();
  if (!key) return { success: false, needsCodeAdaptation: false, error: 'API Key 不能为空' };
  const profile = createCustomRealtimeVoiceProfile(provider);
  const url = profile.wsUrl(profile.defaultModel);

  return new Promise((resolve) => {
    let settled = false;
    let sessionUpdateSent = false;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      // Custom IDs are outside the model-provider proxy registry. Passing the
      // custom ID would default to direct; URL-based resolution keeps global
      // proxy support while still respecting direct-connect hosts.
      agent: getHttpsAgent(url),
    });
    const finish = (result: CustomRealtimeProviderTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      success: false,
      needsCodeAdaptation: sessionUpdateSent,
      error: sessionUpdateSent
        ? '端点未返回兼容的 session.updated 回显'
        : '连接测试超时',
    }), CUSTOM_PROVIDER_TEST_TIMEOUT_MS);
    ws.on('message', (raw) => {
      try {
        const event = JSON.parse(String(raw)) as {
          type?: unknown;
          error?: { message?: unknown };
        };
        if (event.type === 'session.created' && !sessionUpdateSent) {
          sessionUpdateSent = true;
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              model: profile.defaultModel,
              output_modalities: ['audio'],
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: profile.inputSampleRate },
                },
                output: {
                  format: { type: 'audio/pcm' },
                  voice: profile.defaultVoice,
                },
              },
            },
          }));
          return;
        }
        if (event.type === 'session.updated' && sessionUpdateSent) {
          finish({ success: true, needsCodeAdaptation: false });
          return;
        }
        if (event.type === 'error') {
          finish({
            success: false,
            needsCodeAdaptation: false,
            error: safeProviderError(
              typeof event.error?.message === 'string' ? event.error.message : '上游返回错误',
              key,
            ),
          });
          return;
        }
        // session.created 之后允许 rate_limits.updated 等无关事件插队；
        // 只有 session.updated / error / close / timeout 才能结束协议确认。
        if (!sessionUpdateSent) {
          finish({
            success: false,
            needsCodeAdaptation: true,
            error: '端点未返回兼容的 session.created 事件',
          });
        }
      } catch {
        finish({
          success: false,
          needsCodeAdaptation: true,
          error: '端点返回了非兼容事件',
        });
      }
    });
    ws.once('error', (error) => finish({
      success: false,
      needsCodeAdaptation: false,
      error: safeProviderError(error, key),
    }));
    ws.once('close', () => finish({
      success: false,
      needsCodeAdaptation: sessionUpdateSent,
      error: sessionUpdateSent
        ? '端点未返回兼容的 session.updated 回显'
        : '连接在协议确认前关闭',
    }));
  });
}

export async function saveCustomRealtimeVoiceProvider(
  input: CustomRealtimeVoiceProviderInput,
  apiKey: string,
): Promise<CustomRealtimeVoiceProviderSettings> {
  const current = listCustomRealtimeVoiceProviders();
  const previous = current.find((provider) => provider.id === input.id.trim().toLowerCase());
  const normalized = normalizeCustomRealtimeProviderInput(input, previous);
  const tested = await testCustomRealtimeVoiceProvider(input, apiKey);
  if (!tested.success) throw new Error(tested.error ?? 'Provider 连接测试失败');

  const storage = getSecureStorage();
  const slot = keySlot(normalized.id);
  const previousKey = storage.getApiKey(slot);
  storage.setApiKey(slot, apiKey.trim());
  const settings = getConfigService().getSettings();
  try {
    await getConfigService().updateSettings({
      voice: {
        ...settings.voice,
        live: {
          ...settings.voice?.live,
          customProviders: [...current.filter((provider) => provider.id !== normalized.id), normalized],
        },
      },
    });
  } catch (error) {
    if (previousKey) storage.setApiKey(slot, previousKey);
    else storage.deleteApiKey(slot);
    throw error;
  }
  return normalized;
}

export async function deleteCustomRealtimeVoiceProvider(id: string): Promise<void> {
  const normalizedId = id.trim().toLowerCase();
  const settings = getConfigService().getSettings();
  const live = settings.voice?.live;
  const customProviders = listCustomRealtimeVoiceProviders(live)
    .filter((provider) => provider.id !== normalizedId);
  await getConfigService().updateSettings({
    voice: {
      ...settings.voice,
      live: {
        ...live,
        providerId: live?.providerId === normalizedId ? 'dashscope-qwen-omni' : live?.providerId,
        customProviders,
      },
    },
  });
  getSecureStorage().deleteApiKey(keySlot(normalizedId));
}
