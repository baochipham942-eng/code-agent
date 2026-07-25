// ============================================================================
// Privacy Flags — 用户隐私开关的解析（host 与 renderer 共用的唯一口径）
// ============================================================================
//
// 2026-07-25 费曼审计 P0-1：设置页遥测开关此前只写 langfuse.enabled 一个字段，
// 四类遥测通道里三类完全不读它。两个开关的「承诺 → 通道」映射收拢在：
//   - host 侧：src/host/observability/privacyGate.ts
//   - renderer 侧：src/renderer/observability/privacyFlags.ts
// 本文件只负责 settings → 两档布尔 的解析，保证两侧口径一致。
// ============================================================================

interface PrivacySettingsShape {
  privacy?: {
    usageDataEnabled?: boolean;
    crashReportingEnabled?: boolean;
  };
  langfuse?: {
    enabled?: boolean;
  };
}

export interface PrivacyFlags {
  /** 使用数据：LLM tracing（Langfuse）+ 产品分析（PostHog）+ fleet telemetry（Supabase） */
  usageData: boolean;
  /** 崩溃报告：Sentry（node + renderer） */
  crashReporting: boolean;
}

/** settings → 两档开关；兼容旧字段 langfuse.enabled（此前设置页唯一写入点，默认开）。 */
export function resolvePrivacyFlags(settings: PrivacySettingsShape | undefined): PrivacyFlags {
  return {
    usageData: settings?.privacy?.usageDataEnabled ?? (settings?.langfuse?.enabled !== false),
    crashReporting: settings?.privacy?.crashReportingEnabled ?? true,
  };
}
