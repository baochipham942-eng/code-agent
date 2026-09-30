// ============================================================================
// Privacy Flags — 用户隐私开关的解析（host 与 renderer 共用的唯一口径）
// ============================================================================
//
// 四个通道各自成档：posthog / cloudUpload / langfuse / crashReporting。
// 解析顺序（每一档独立）：
//   1. 环境变量硬关（DO_NOT_TRACK，其次 NEO_DISABLE_TELEMETRY；只认 1 / true，忽略大小写）
//   2. settings.privacy.<channel>Enabled
//   3. 旧字段 usageDataEnabled，再其次 langfuse.enabled（旧设置文件保持原行为）
//   4. 默认开
//
// 崩溃报告同样被这两个环境变量硬关。sentry 模块只说运行时开关由配置层控制，
// 没有把崩溃报告从进程级 opt-out 里摘出去；崩溃载荷仍然会离开本机。
// 两个变量同时设置时，来源记为 env:DO_NOT_TRACK。
//
// 纯函数：调用方传入 env，不要在别的模块里再读这两个变量。
// ============================================================================

export const TELEMETRY_ENV_WINDOW_KEY = '__NEO_TELEMETRY_ENV__';

const TELEMETRY_OPT_OUT_ENV_KEYS = ['DO_NOT_TRACK', 'NEO_DISABLE_TELEMETRY'] as const;

type TelemetryEnvOptOutName = (typeof TELEMETRY_OPT_OUT_ENV_KEYS)[number];

export type PrivacyFlagSource =
  | 'env:DO_NOT_TRACK'
  | 'env:NEO_DISABLE_TELEMETRY'
  | 'settings.privacy.posthogEnabled'
  | 'settings.privacy.cloudUploadEnabled'
  | 'settings.privacy.langfuseEnabled'
  | 'settings.privacy.crashReportingEnabled'
  | 'legacy:usageDataEnabled'
  | 'legacy:langfuse.enabled'
  | 'default';

interface PrivacyChannelDecision {
  enabled: boolean;
  source: PrivacyFlagSource;
}

export interface PrivacyResolution {
  posthog: PrivacyChannelDecision;
  cloudUpload: PrivacyChannelDecision;
  langfuse: PrivacyChannelDecision;
  crashReporting: PrivacyChannelDecision;
}

export interface PrivacyFlags {
  posthog: boolean;
  cloudUpload: boolean;
  langfuse: boolean;
  crashReporting: boolean;
}

export interface PrivacyEnv {
  DO_NOT_TRACK?: string;
  NEO_DISABLE_TELEMETRY?: string;
}

const USAGE_SETTING_SOURCE = {
  posthogEnabled: 'settings.privacy.posthogEnabled',
  cloudUploadEnabled: 'settings.privacy.cloudUploadEnabled',
  langfuseEnabled: 'settings.privacy.langfuseEnabled',
} as const satisfies Record<string, PrivacyFlagSource>;

type UsageSettingField = keyof typeof USAGE_SETTING_SOURCE;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function isEnvHardOff(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/** 页面注入只用这两个键，避免把整个 process.env 送进 HTML。 */
export function telemetryPageEnv(env: PrivacyEnv | undefined): Record<string, string> {
  const page: Record<string, string> = {};
  if (!env) return page;
  for (const key of TELEMETRY_OPT_OUT_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string') page[key] = value;
  }
  return page;
}

export function readTelemetryEnvOptOut(env: PrivacyEnv | undefined): TelemetryEnvOptOutName | null {
  if (isEnvHardOff(env?.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (isEnvHardOff(env?.NEO_DISABLE_TELEMETRY)) return 'NEO_DISABLE_TELEMETRY';
  return null;
}

function envDecision(name: TelemetryEnvOptOutName): PrivacyChannelDecision {
  if (name === 'DO_NOT_TRACK') return { enabled: false, source: 'env:DO_NOT_TRACK' };
  return { enabled: false, source: 'env:NEO_DISABLE_TELEMETRY' };
}

function decideUsage(
  field: UsageSettingField,
  privacy: Record<string, unknown> | undefined,
  legacyUsage: boolean | undefined,
  legacyLangfuse: boolean | undefined,
  optOut: TelemetryEnvOptOutName | null,
): PrivacyChannelDecision {
  if (optOut) return envDecision(optOut);
  const own = readBoolean(privacy, field);
  if (own !== undefined) return { enabled: own, source: USAGE_SETTING_SOURCE[field] };
  if (legacyUsage !== undefined) return { enabled: legacyUsage, source: 'legacy:usageDataEnabled' };
  if (legacyLangfuse !== undefined) return { enabled: legacyLangfuse, source: 'legacy:langfuse.enabled' };
  return { enabled: true, source: 'default' };
}

function decideCrash(
  privacy: Record<string, unknown> | undefined,
  optOut: TelemetryEnvOptOutName | null,
): PrivacyChannelDecision {
  if (optOut) return envDecision(optOut);
  const own = readBoolean(privacy, 'crashReportingEnabled');
  if (own !== undefined) return { enabled: own, source: 'settings.privacy.crashReportingEnabled' };
  return { enabled: true, source: 'default' };
}

export function explainPrivacyFlags(settings: unknown, env: PrivacyEnv = process.env): PrivacyResolution {
  const root = asRecord(settings);
  const privacy = asRecord(root?.privacy);
  const langfuse = asRecord(root?.langfuse);
  const legacyUsage = readBoolean(privacy, 'usageDataEnabled');
  const legacyLangfuse = readBoolean(langfuse, 'enabled');
  const optOut = readTelemetryEnvOptOut(env);
  return {
    posthog: decideUsage('posthogEnabled', privacy, legacyUsage, legacyLangfuse, optOut),
    cloudUpload: decideUsage('cloudUploadEnabled', privacy, legacyUsage, legacyLangfuse, optOut),
    langfuse: decideUsage('langfuseEnabled', privacy, legacyUsage, legacyLangfuse, optOut),
    crashReporting: decideCrash(privacy, optOut),
  };
}

export function resolvePrivacyFlags(settings: unknown, env: PrivacyEnv = process.env): PrivacyFlags {
  const explained = explainPrivacyFlags(settings, env);
  return {
    posthog: explained.posthog.enabled,
    cloudUpload: explained.cloudUpload.enabled,
    langfuse: explained.langfuse.enabled,
    crashReporting: explained.crashReporting.enabled,
  };
}
