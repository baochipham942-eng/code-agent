import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 标记 TTL 的规格值（拍板 30 分钟）：测试直接钉住这个数字，靠 fake timers 推过边界。
const AVAILABILITY_MARK_TTL_MS = 30 * 60_000;

type MonitorModule = typeof import('../../../src/host/model/providerHealthMonitor');
let getProviderHealthMonitor: MonitorModule['getProviderHealthMonitor'];

describe('ProviderHealthMonitor', () => {
  beforeEach(async () => {
    // 单例没有测试专用重置出口：每个测试重载模块图，拿全新的 monitor 实例。
    vi.resetModules();
    ({ getProviderHealthMonitor } = await import('../../../src/host/model/providerHealthMonitor'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('取消失败不改变错误率或健康状态', () => {
    const provider = 'cancelled-failure-health-test';
    const monitor = getProviderHealthMonitor();
    monitor.recordSuccess(provider, 20);
    const before = monitor.getHealth(provider);
    const beforeCount = monitor.getObservationCount(provider);

    monitor.recordFailure(provider, { cancelled: true });

    expect(monitor.getHealth(provider)).toEqual(before);
    expect(monitor.getObservationCount(provider)).toBe(beforeCount);
    expect(monitor.getHealth(provider)).toMatchObject({
      status: 'healthy',
      errorRate: 0,
      consecutiveErrors: 0,
    });
  });

  it('模型级 400 只标该模型，不把供应商打成 unavailable', () => {
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).toMatchObject({ scope: 'model', kind: 'model' });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0')).toBeNull();
    expect(monitor.getHealth('longcat')?.status).not.toBe('unavailable');
  });

  it('供应商级 401 标整家；成功一次立即清除该级标记', () => {
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')?.kind).toBe('auth');
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0')?.kind).toBe('auth');
    monitor.recordSuccess('longcat', 12, { model: 'LongCat-2.0' });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).toBeNull();
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0')).toBeNull();
  });

  it('模型级成功只清这一个模型，不清 Preview 的停用标记', () => {
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    monitor.recordSuccess('longcat', 11, { model: 'LongCat-2.0' });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')?.kind).toBe('model');
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0')).toBeNull();
  });

  it('30 分钟后标记自动消失，不依赖连续成功 3 次', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'));
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).not.toBeNull();
    vi.setSystemTime(new Date('2026-09-17T10:30:00.001Z'));
    expect(Date.now() - Date.parse('2026-09-17T10:00:00Z')).toBeGreaterThan(AVAILABILITY_MARK_TTL_MS - 1);
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).toBeNull();
  });
});
