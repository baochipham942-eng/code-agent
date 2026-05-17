// ============================================================================
// Doctor Check - Network 连通性
// 对**已配置 API Key** 的 provider 跑 handleTestConnection；
// 未配置的标 `skip`，不计入 fail。
// ============================================================================

import { PROVIDER_REGISTRY } from '../../../shared/constants';
import type { BuiltInModelProvider } from '../../../shared/contract';
import { handleTestConnection } from '../../ipc/provider.ipc';
import { getConfigService } from '../../services/core/configService';
import type { DoctorItem } from '../types';

/**
 * 检查所有已配置 provider 的连通性。
 * 未配置 API Key 的 provider 返回 `skip` 项。
 * 单项失败映射：
 *   - HTTP 200 → pass
 *   - TIMEOUT → warn（不视为 fail，可能只是网络慢）
 *   - 401/403 → fail（key 错误明确）
 *   - 其他 → warn
 */
export async function checkProviderConnectivity(): Promise<DoctorItem[]> {
  const config = getConfigService();
  const providerEntries = Object.entries(PROVIDER_REGISTRY) as Array<
    [BuiltInModelProvider, (typeof PROVIDER_REGISTRY)[BuiltInModelProvider]]
  >;

  const results = await Promise.allSettled(
    providerEntries.map(async ([providerId, info]): Promise<DoctorItem> => {
      const apiKey = config.getApiKey(providerId);
      if (!apiKey) {
        return {
          category: 'network',
          name: info.displayName,
          status: 'skip',
          message: '未配置 API Key',
        };
      }

      const started = Date.now();
      try {
        const result = await handleTestConnection({
          provider: providerId,
          apiKey,
        });
        const durationMs = Date.now() - started;

        if (result.success) {
          return {
            category: 'network',
            name: info.displayName,
            status: 'pass',
            message: `${result.latencyMs}ms`,
            durationMs,
          };
        }

        const code = result.error?.code;
        const isFail = code === 'AUTH_FAILED' || code === 'FORBIDDEN';
        return {
          category: 'network',
          name: info.displayName,
          status: isFail ? 'fail' : 'warn',
          message: result.error?.message ?? '连接失败',
          suggestion: result.error?.suggestion,
          details: code,
          durationMs,
        };
      } catch (err) {
        return {
          category: 'network',
          name: info.displayName,
          status: 'warn',
          message: `内部错误: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - started,
        };
      }
    }),
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          category: 'network' as const,
          name: providerEntries[i][1].displayName,
          status: 'warn' as const,
          message: '检查异常',
          details: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}
