// ============================================================================
// Doctor Check - Provider Health（运行时健康监控状态）
// 复用 providerHealthMonitor 的滚动窗口数据，
// 把 healthy/degraded/recovering/unavailable 映射为 pass/warn/warn/fail。
// ============================================================================

import { getProviderHealthMonitor } from '../../model/providerHealthMonitor';
import type { DoctorItem } from '../types';

export function checkProviderHealth(): DoctorItem[] {
  const monitor = getProviderHealthMonitor();
  const healthMap = monitor.getHealthMap();

  if (healthMap.size === 0) {
    return [
      {
        category: 'provider_health',
        name: 'Provider 健康监控',
        status: 'skip',
        message: '尚无运行时数据（未发起过 API 请求）',
      },
    ];
  }

  const items: DoctorItem[] = [];
  for (const [provider, health] of healthMap) {
    let status: DoctorItem['status'];
    let suggestion: string | undefined;
    switch (health.status) {
      case 'healthy':
        status = 'pass';
        break;
      case 'degraded':
        status = 'warn';
        suggestion = '错误率偏高，可观察是否需要切换 provider';
        break;
      case 'recovering':
        status = 'warn';
        suggestion = '正在恢复中，连续成功 3 次后会回到 healthy';
        break;
      case 'unavailable':
        status = 'fail';
        suggestion = '错误率超过 70%，建议临时切换到其他 provider';
        break;
      default:
        status = 'warn';
    }

    const errorRatePct = (health.errorRate * 100).toFixed(1);
    items.push({
      category: 'provider_health',
      name: provider,
      status,
      message: `${health.status} · p50 ${health.latencyP50}ms · err ${errorRatePct}%`,
      details: `consecutiveErrors=${health.consecutiveErrors}, p95=${health.latencyP95}ms`,
      suggestion,
    });
  }

  return items;
}
