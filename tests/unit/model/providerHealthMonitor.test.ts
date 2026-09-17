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

  /**
   * ai-review R7（Nit）：网络类（5xx/断网）一笔最终失败不给整家打 30 分钟标记——那会把手机
   * 默认模型切到别家且难以自愈（默认已换走，不再有请求来清标记）。门槛沿用错误率阈值：
   * 只有健康态已被此前失败推到 unavailable，这笔网络失败才升格成供应商级标记。
   * auth/quota 是持久性问题（key 无效/余额耗尽），维持一次即标。
   */
  it('网络类：单次 503 不标整家；连发到错误率把健康态推过阈值后才标', () => {
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0',
      error: Object.assign(new Error('Service unavailable'), { status: 503 }),
    });
    // 第一笔 503：这笔之前的健康态还是 healthy，不打供应商标记
    expect(monitor.getProviderMark('longcat')).toBeNull();
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0')).toBeNull();
    // 第一笔已把错误率推到 100%（≥70% 阈值），健康态落 unavailable；第二笔起才标
    expect(monitor.getHealth('longcat')?.status).toBe('unavailable');
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0',
      error: Object.assign(new Error('Service unavailable'), { status: 503 }),
    });
    expect(monitor.getProviderMark('longcat')).toMatchObject({ scope: 'provider', kind: 'network' });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0')).toMatchObject({ kind: 'network' });
  });

  it('网络类：供应商有成功历史时单次 5xx 不标（错误率远未过阈值）', () => {
    const monitor = getProviderHealthMonitor();
    for (let i = 0; i < 5; i += 1) monitor.recordSuccess('deepseek', 20, { model: 'deepseek-chat' });
    monitor.recordFailure('deepseek', {
      model: 'deepseek-chat',
      error: Object.assign(new Error('Bad gateway'), { status: 502 }),
    });
    expect(monitor.getHealth('deepseek')?.status).toBe('healthy');
    expect(monitor.getProviderMark('deepseek')).toBeNull();
  });

  it('auth 维持一次即标：单次 401 不等错误率', () => {
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('moonshot', {
      model: 'kimi-k2.5',
      error: Object.assign(new Error('Unauthorized'), { status: 401 }),
    });
    expect(monitor.getProviderMark('moonshot')).toMatchObject({ scope: 'provider', kind: 'auth' });
  });
});
