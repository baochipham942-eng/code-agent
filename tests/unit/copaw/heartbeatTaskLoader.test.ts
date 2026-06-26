// ============================================================================
// Heartbeat Task Loader Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isWithinActiveHours } from '../../../src/host/cron/heartbeatTaskLoader';

// Mock dependencies
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getProjectConfigDir: (dir: string) => `${dir}/.code-agent`,
}));

describe('isWithinActiveHours', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setNow = (h: number, m: number) => {
    vi.setSystemTime(new Date(2026, 0, 15, h, m, 0, 0));
  };

  it('returns true when no activeHours specified', () => {
    expect(isWithinActiveHours()).toBe(true);
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it('returns true for invalid format', () => {
    expect(isWithinActiveHours('invalid')).toBe(true);
    expect(isWithinActiveHours('08-18')).toBe(true);
  });

  it('handles same-day window (08:00-18:00) with strict minute boundary', () => {
    setNow(7, 59);
    expect(isWithinActiveHours('08:00-18:00')).toBe(false);
    setNow(8, 0);
    expect(isWithinActiveHours('08:00-18:00')).toBe(true);
    setNow(13, 30);
    expect(isWithinActiveHours('08:00-18:00')).toBe(true);
    setNow(18, 0);
    expect(isWithinActiveHours('08:00-18:00')).toBe(true);
    // same-day 保持严格分钟边界，18:01 即出窗口
    setNow(18, 1);
    expect(isWithinActiveHours('08:00-18:00')).toBe(false);
  });

  it('respects explicit minute precision in same-day window (23:00-23:30)', () => {
    setNow(23, 0);
    expect(isWithinActiveHours('23:00-23:30')).toBe(true);
    setNow(23, 30);
    expect(isWithinActiveHours('23:00-23:30')).toBe(true);
    setNow(23, 31);
    expect(isWithinActiveHours('23:00-23:30')).toBe(false);
    setNow(22, 59);
    expect(isWithinActiveHours('23:00-23:30')).toBe(false);
  });

  it('handles midnight-crossing window (22:00-06:00) inclusively across the end hour', () => {
    setNow(21, 59);
    expect(isWithinActiveHours('22:00-06:00')).toBe(false);
    setNow(22, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    setNow(23, 30);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    setNow(0, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    setNow(5, 59);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    setNow(6, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    // 回归：旧实现这里返回 false（endMinutes=360 严格边界），现按整点小时结束语义
    setNow(6, 30);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    setNow(6, 59);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    setNow(7, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(false);
    setNow(12, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(false);
  });
});

describe('HeartbeatTaskLoader parsing', () => {
  it('should parse HEARTBEAT.md format', async () => {
    const fs = await import('fs');
    const { HeartbeatTaskLoader } = await import('../../../src/host/cron/heartbeatTaskLoader');

    const content = `### 每日代码检查
- cron: 0 9 * * 1-5
- prompt: 运行 npm run typecheck，如有错误则汇总报告
- channel: feishu
- active_hours: 08:00-18:00
- enabled: true

### 周末备份
- cron: 0 2 * * 6
- prompt: 执行数据库备份
- enabled: false

### 缺少必填字段
- cron: 0 12 * * *
- enabled: true
`;

    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(content);

    // 创建 mock cronService
    const mockCronService = {
      scheduleCron: vi.fn().mockResolvedValue({ id: 'job-1' }),
      deleteJob: vi.fn().mockResolvedValue(true),
    } as any;

    const loader = new HeartbeatTaskLoader({
      workingDirectory: '/project',
      cronService: mockCronService,
    });

    await loader.loadFromFile();

    // 应该只注册 enabled=true 且有 cron+prompt 的任务
    // "每日代码检查" → enabled=true, has cron+prompt → 注册
    // "周末备份" → enabled=false → 跳过
    // "缺少必填字段" → 没有 prompt → 跳过
    expect(mockCronService.scheduleCron).toHaveBeenCalledTimes(1);
    expect(mockCronService.scheduleCron).toHaveBeenCalledWith(
      '0 9 * * 1-5',
      expect.objectContaining({
        type: 'agent',
        prompt: '运行 npm run typecheck，如有错误则汇总报告',
      }),
      expect.objectContaining({
        name: '[Heartbeat] 每日代码检查',
      })
    );
  });

  it('should cleanup old jobs before registering new ones', async () => {
    const fs = await import('fs');
    vi.resetModules();
    const { HeartbeatTaskLoader } = await import('../../../src/host/cron/heartbeatTaskLoader');

    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(`### Task1
- cron: 0 9 * * *
- prompt: do something
`);

    const mockCronService = {
      scheduleCron: vi.fn()
        .mockResolvedValueOnce({ id: 'old-job-1' })
        .mockResolvedValueOnce({ id: 'new-job-1' }),
      deleteJob: vi.fn().mockResolvedValue(true),
    } as any;

    const loader = new HeartbeatTaskLoader({
      workingDirectory: '/project',
      cronService: mockCronService,
    });

    // First load
    await loader.loadFromFile();
    expect(mockCronService.scheduleCron).toHaveBeenCalledTimes(1);

    // Second load (should cleanup old-job-1)
    await loader.loadFromFile();
    expect(mockCronService.deleteJob).toHaveBeenCalledWith('old-job-1');
    expect(mockCronService.scheduleCron).toHaveBeenCalledTimes(2);
  });
});
