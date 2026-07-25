// ============================================================================
// Privacy Flags (Renderer) — 隐私开关到 renderer 侧遥测通道的接线点
// ============================================================================
//
// 与 host 侧 privacyGate 对称：解析口径共用 shared/observability/privacyFlags。
// 调用时机：App 启动加载 settings 后一次 + 设置页开关切换时立即重放。
// 新增 renderer 遥测通道必须在这里接线（privacySwitchWiring 门守着）。
// ============================================================================

import { resolvePrivacyFlags, type PrivacyFlags } from '@shared/observability/privacyFlags';
import { setPostHogEnabled } from './posthogRenderer';
import { setCrashReportingEnabled } from './sentryRenderer';

export { resolvePrivacyFlags };
export type { PrivacyFlags };

export function applyRendererPrivacyFlags(flags: PrivacyFlags): void {
  setPostHogEnabled(flags.usageData);
  setCrashReportingEnabled(flags.crashReporting);
}
