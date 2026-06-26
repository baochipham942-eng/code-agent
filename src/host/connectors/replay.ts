// ============================================================================
// Connector Replay - 启动时按用户设置同步 Registry
// ============================================================================

import type { ConfigService } from '../services/core/configService';
import { getConnectorRegistry } from './registry';

/**
 * 根据 configService 中的 connectors.enabledNative 同步 Registry。
 * 在核心服务初始化后（桌面 / web 两种入口都需要）调用。
 */
export function replayNativeConnectors(configService: ConfigService): string[] {
  const enabled = configService.getSettings().connectors?.enabledNative ?? [];
  getConnectorRegistry().configure(enabled);
  return enabled;
}
