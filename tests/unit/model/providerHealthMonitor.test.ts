import { describe, expect, it } from 'vitest';
import { getProviderHealthMonitor } from '../../../src/host/model/providerHealthMonitor';

describe('ProviderHealthMonitor', () => {
  it('取消失败不改变错误率或健康状态', () => {
    const provider = 'cancelled-failure-health-test';
    const monitor = getProviderHealthMonitor();
    monitor.recordSuccess(provider, 20);
    const before = monitor.getHealth(provider);

    monitor.recordFailure(provider, { cancelled: true });

    expect(monitor.getHealth(provider)).toEqual(before);
    expect(monitor.getHealth(provider)).toMatchObject({
      status: 'healthy',
      errorRate: 0,
      consecutiveErrors: 0,
    });
  });
});
