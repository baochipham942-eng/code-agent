// ============================================================================
// Heartbeat Task Loader Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isWithinActiveHours } from '../../../src/main/cron/heartbeatTaskLoader';

// Mock dependencies
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/config/configPaths', () => ({
  getProjectConfigDir: (dir: string) => `${dir}/.code-agent`,
}));

describe('isWithinActiveHours', () => {
  it('should return true when no activeHours specified', () => {
    expect(isWithinActiveHours()).toBe(true);
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it('should return true for invalid format', () => {
    expect(isWithinActiveHours('invalid')).toBe(true);
    expect(isWithinActiveHours('08-18')).toBe(true);
  });

  it('should check normal time range (not crossing midnight)', () => {
    const now = new Date();
    const currentH = now.getHours();
    const currentM = now.getMinutes();

    // Create a window that includes current time
    const startH = String(Math.max(0, currentH - 1)).padStart(2, '0');
    const endH = String(Math.min(23, currentH + 1)).padStart(2, '0');
    expect(isWithinActiveHours(`${startH}:00-${endH}:59`)).toBe(true);

    // Create a window that excludes current time (far future)
    if (currentH < 20) {
      expect(isWithinActiveHours('23:00-23:30')).toBe(false);
    }
  });

  it('should handle midnight-crossing ranges', () => {
    const now = new Date();
    const currentH = now.getHours();

    // 22:00-06:00 range (crosses midnight)
    if (currentH >= 22 || currentH <= 6) {
      expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    } else {
      expect(isWithinActiveHours('22:00-06:00')).toBe(false);
    }
  });
});

describe('HeartbeatTaskLoader parsing', () => {
  it('should parse HEARTBEAT.md format', async () => {
    const fs = await import('fs');
    const { HeartbeatTaskLoader } = await import('../../../src/main/cron/heartbeatTaskLoader');

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
    const { HeartbeatTaskLoader } = await import('../../../src/main/cron/heartbeatTaskLoader');

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
