// ============================================================================
// Privacy Gate — 隐私开关到 node 侧遥测通道的唯一「承诺 → 通道」接线点
// ============================================================================
//
// 背景（2026-07-25 费曼审计 P0-1）：真实发行版跑的 webServer 路径不初始化
// Langfuse，PostHog / Sentry / Supabase fleet telemetry 各自只看 env key，
// 三个 opt-out 函数全仓零调用。本文件把四个通道开关一次接到各自的出口；
// renderer 只写 settings.privacy.*，不再构造通道字段。
// 环境变量硬关在 shared resolvePrivacyFlags 里算完，这里只按结果接线。
//
// 新增遥测通道必须在 applyPrivacyFlags 接线——tests/scripts/
// privacySwitchWiring.test.ts 扫描通道模块的 set*Enabled 出口并断言本文件
// 引用了它，漏接会红。
// ============================================================================

import type { AppSettings } from '../../shared/contract/settings';
import type { ConfigService } from '../services/core/configService';
import { resolvePrivacyFlags, type PrivacyFlags } from '../../shared/observability/privacyFlags';
import { createLogger } from '../services/infra/logger';
import { setPostHogEnabled } from './posthogNode';
import { setCrashReportingEnabled } from './sentryNode';
import { flushPendingCrashReport } from './crashMarker';
import { getTelemetryUploaderService } from '../telemetry/telemetryUploaderService';
import { getLangfuseService } from '../services/infra/langfuseService';

const logger = createLogger('PrivacyGate');

/** node 侧全通道接线；renderer 侧对应逻辑在 src/renderer/observability/privacyFlags.ts。 */
export function applyPrivacyFlags(flags: PrivacyFlags): void {
  setPostHogEnabled(flags.posthog);
  getTelemetryUploaderService().setEnabled(flags.cloudUpload);
  getLangfuseService().setEnabled(flags.langfuse);
  setCrashReportingEnabled(flags.crashReporting);
  logger.info('Privacy flags applied', { ...flags });
}

/** webServer 启动时调用：按当前设置立即接线，并跟随后续每次设置写入重放。 */
export function installPrivacyGate(configService: ConfigService): void {
  applyPrivacyFlags(resolvePrivacyFlags(configService.getSettings(), process.env));
  // 启动期暂存的 crash 检测此刻才上报——开关已生效，opt-out 用户一发都不会漏出去
  flushPendingCrashReport();
  configService.onSettingsUpdated((settings: AppSettings) => {
    applyPrivacyFlags(resolvePrivacyFlags(settings, process.env));
  });
}
