// ============================================================================
// Renderer hot-update telemetry - metadata-only attempt recording
// ============================================================================

import { getTelemetryStorage } from '../../telemetry/telemetryStorage';
import type { RendererBundleStatus } from '../../../shared/contract/update';

export async function recordRendererBundleTelemetryAttempt(status: RendererBundleStatus): Promise<void> {
  getTelemetryStorage().recordRendererBundleAttempt(status);
}
