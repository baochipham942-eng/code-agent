// ============================================================================
// Privacy Flags (Renderer) — 隐私开关到 renderer 侧遥测通道的接线点
// ============================================================================
//
// 与 host 侧 privacyGate 对称：解析口径共用 shared/observability/privacyFlags。
// 调用时机：App 启动加载 settings 后一次 + 设置页开关切换时立即重放。
// 新增 renderer 遥测通道必须在这里接线（privacySwitchWiring 门守着）。
//
// 页面读不到宿主进程的环境变量。静态页注入 window.__NEO_TELEMETRY_ENV__
// （只有 DO_NOT_TRACK / NEO_DISABLE_TELEMETRY 两个键）后，从这里读。
// ============================================================================

import {
  TELEMETRY_ENV_WINDOW_KEY,
  readTelemetryEnvOptOut,
  resolvePrivacyFlags,
  telemetryPageEnv,
  type PrivacyEnv,
  type PrivacyFlags,
} from '@shared/observability/privacyFlags';
import { setPostHogEnabled } from './posthogRenderer';
import { setCrashReportingEnabled } from './sentryRenderer';

export { resolvePrivacyFlags, readTelemetryEnvOptOut };
export type { PrivacyFlags };

export function readReportedTelemetryEnv(): PrivacyEnv {
  if (typeof window === 'undefined') return {};
  const raw = (window as unknown as Record<string, unknown>)[TELEMETRY_ENV_WINDOW_KEY];
  if (!raw || typeof raw !== 'object') return {};
  return telemetryPageEnv(raw as PrivacyEnv);
}

export function applyRendererPrivacyFlags(flags: PrivacyFlags): void {
  setPostHogEnabled(flags.posthog);
  setCrashReportingEnabled(flags.crashReporting);
}
