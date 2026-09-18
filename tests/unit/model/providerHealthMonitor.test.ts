import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModelMarkFileStore } from '../../../src/host/model/availabilityMarkPersistence';

// 标记 TTL 的规格值（拍板 30 分钟）：测试直接钉住这个数字，靠 fake timers 推过边界。
const AVAILABILITY_MARK_TTL_MS = 30 * 60_000;

type MonitorModule = typeof import('../../../src/host/model/providerHealthMonitor');
let getProviderHealthMonitor: MonitorModule['getProviderHealthMonitor'];
let armModelMarkPersistence: MonitorModule['armModelMarkPersistence'];

describe('ProviderHealthMonitor', () => {
  beforeEach(async () => {
    // 单例没有测试专用重置出口：每个测试重载模块图，拿全新的 monitor 实例。
    vi.resetModules();
    ({ getProviderHealthMonitor, armModelMarkPersistence } = await import('../../../src/host/model/providerHealthMonitor'));
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

  it('模型级标记不吃 30 分钟 TTL（停用不自愈）；provider 级标记照旧过 TTL 消失（N-MOBILE-CONN-POLISH-R3 ④）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'));
    const monitor = getProviderHealthMonitor();
    monitor.recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    monitor.recordFailure('moonshot', {
      error: Object.assign(new Error('Unauthorized'), { status: 401 }),
    });
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).not.toBeNull();
    vi.setSystemTime(new Date('2026-09-17T10:30:00.001Z'));
    expect(Date.now() - Date.parse('2026-09-17T10:00:00Z')).toBeGreaterThan(AVAILABILITY_MARK_TTL_MS - 1);
    // 模型级仍在：清它只有一条路——该模型成功一次（recordSuccess）。TTL 一到就自愈的话，
    // 回落链会把「从未调用过」的已停用模型当好模型选中。
    expect(monitor.getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).toMatchObject({ scope: 'model', kind: 'model' });
    // provider 级照旧：网络/auth/quota 是瞬态，30 分钟自动消失。
    expect(monitor.getProviderMark('moonshot')).toBeNull();
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

describe('模型级标记持久化（内存为真源 + 变更落盘 + 重启回灌，N-MOBILE-CONN-POLISH-R3 ④）', () => {
  const unsupported = () => Object.assign(new Error('Unsupported model'), { status: 400 });

  it('recordFailure 落盘；换新 monitor 实例、同一存储（模拟重启）回灌，标记与回落判据仍在', async () => {
    const file = path.join(tmpdir(), `model-marks-${randomUUID()}.json`);
    try {
      vi.resetModules();
      ({ getProviderHealthMonitor, armModelMarkPersistence } = await import('../../../src/host/model/providerHealthMonitor'));
      armModelMarkPersistence(createModelMarkFileStore(file));
      getProviderHealthMonitor().recordFailure('longcat', { model: 'LongCat-2.0-Preview', error: unsupported() });
      expect(existsSync(file)).toBe(true);
      // 模拟重启：重载模块图拿全新单例（生产里就是新进程），同一份存储 = 同一个文件。
      vi.resetModules();
      ({ getProviderHealthMonitor, armModelMarkPersistence } = await import('../../../src/host/model/providerHealthMonitor'));
      armModelMarkPersistence(createModelMarkFileStore(file));
      expect(getProviderHealthMonitor().getAvailabilityMark('longcat', 'LongCat-2.0-Preview'))
        .toMatchObject({ scope: 'model', kind: 'model' });
      expect(getProviderHealthMonitor().getAvailabilityMark('longcat', 'LongCat-2.0')).toBeNull();
      // provider 级标记不落盘：重启后没有（瞬态，本就该内存 + TTL）。
      expect(getProviderHealthMonitor().getProviderMark('longcat')).toBeNull();
      // recordSuccess 清标记连盘一起清：供应商真重新上架后能自愈。
      getProviderHealthMonitor().recordSuccess('longcat', 10, { model: 'LongCat-2.0-Preview' });
      expect(getProviderHealthMonitor().getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).toBeNull();
      expect((JSON.parse(readFileSync(file, 'utf-8')) as { marks: Record<string, unknown> }).marks).toEqual({});
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('盘上文件坏了不带病回灌：按空处理，新标记照常写', async () => {
    const file = path.join(tmpdir(), `model-marks-${randomUUID()}.json`);
    try {
      writeFileSync(file, 'not json', 'utf-8');
      vi.resetModules();
      ({ getProviderHealthMonitor, armModelMarkPersistence } = await import('../../../src/host/model/providerHealthMonitor'));
      armModelMarkPersistence(createModelMarkFileStore(file));
      expect(getProviderHealthMonitor().getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).toBeNull();
      getProviderHealthMonitor().recordFailure('longcat', { model: 'LongCat-2.0-Preview', error: unsupported() });
      const marks = (JSON.parse(readFileSync(file, 'utf-8')) as { marks: Record<string, unknown> }).marks;
      expect(marks).toMatchObject({ 'longcat\0LongCat-2.0-Preview': { scope: 'model', kind: 'model' } });
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('不挂 store 的单例保持纯内存：行为与接线前一致（单测隔离的根基）', async () => {
    vi.resetModules();
    ({ getProviderHealthMonitor } = await import('../../../src/host/model/providerHealthMonitor'));
    getProviderHealthMonitor().recordFailure('longcat', { model: 'LongCat-2.0-Preview', error: unsupported() });
    expect(getProviderHealthMonitor().getAvailabilityMark('longcat', 'LongCat-2.0-Preview')).not.toBeNull();
    // 没挂 store 不碰默认路径：run 级数据目录里不该出现标记文件。
    const { getUserConfigDir } = await import('../../../src/host/config/configPaths');
    expect(existsSync(path.join(getUserConfigDir(), 'model-availability-marks.json'))).toBe(false);
  });
});
