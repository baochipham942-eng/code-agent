import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HeartbeatTaskLoader,
  isWithinActiveHours,
} from '../../../src/main/cron/heartbeatTaskLoader';
import { getProjectConfigDir } from '../../../src/main/config/configPaths';

describe('isWithinActiveHours', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (h: number, m: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, h, m, 0));
  };

  it('returns true when no window is given', () => {
    expect(isWithinActiveHours()).toBe(true);
    expect(isWithinActiveHours('')).toBe(true);
  });

  it('returns true for a malformed window string', () => {
    at(3, 0);
    expect(isWithinActiveHours('not-a-window')).toBe(true);
  });

  it('handles a same-day window', () => {
    at(10, 0);
    expect(isWithinActiveHours('08:00-18:00')).toBe(true);
    at(7, 59);
    expect(isWithinActiveHours('08:00-18:00')).toBe(false);
    at(18, 0);
    expect(isWithinActiveHours('08:00-18:00')).toBe(true);
  });

  it('handles an overnight window', () => {
    at(23, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    at(2, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    at(12, 0);
    expect(isWithinActiveHours('22:00-06:00')).toBe(false);
  });

  it('treats an HH:00 overnight end as inclusive through that hour', () => {
    // 06:30 must still count as inside a 22:00-06:00 night shift.
    at(6, 30);
    expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    at(7, 1);
    expect(isWithinActiveHours('22:00-06:00')).toBe(false);
  });
});

describe('HeartbeatTaskLoader.loadFromFile', () => {
  let workingDirectory: string;
  let cronService: {
    scheduleCron: ReturnType<typeof vi.fn>;
    deleteJob: ReturnType<typeof vi.fn>;
  };

  const writeHeartbeat = (content: string) => {
    const dir = getProjectConfigDir(workingDirectory);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HEARTBEAT.md'), content, 'utf-8');
  };

  beforeEach(() => {
    workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
    let counter = 0;
    cronService = {
      scheduleCron: vi.fn(async () => ({ id: `job-${++counter}` })),
      deleteJob: vi.fn(async () => true),
    };
  });

  afterEach(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  it('does nothing when HEARTBEAT.md is absent', async () => {
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile();
    expect(cronService.scheduleCron).not.toHaveBeenCalled();
  });

  it('registers enabled tasks and passes channel/activeHours through context', async () => {
    writeHeartbeat(
      [
        '### 每日检查',
        '- cron: 0 9 * * 1-5',
        '- prompt: 运行 typecheck',
        '- channel: feishu',
        '- active_hours: 08:00-18:00',
        '- enabled: true',
        '',
      ].join('\n')
    );
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile();

    expect(cronService.scheduleCron).toHaveBeenCalledTimes(1);
    const [cron, action, options] = cronService.scheduleCron.mock.calls[0];
    expect(cron).toBe('0 9 * * 1-5');
    expect(action).toMatchObject({
      type: 'agent',
      agentType: 'heartbeat',
      prompt: '运行 typecheck',
      context: { channel: 'feishu', activeHours: '08:00-18:00', heartbeatTask: true },
    });
    expect(options.name).toBe('[Heartbeat] 每日检查');
  });

  it('skips disabled tasks and tasks missing cron or prompt', async () => {
    writeHeartbeat(
      [
        '### Disabled',
        '- cron: 0 9 * * *',
        '- prompt: nope',
        '- enabled: false',
        '',
        '### Missing prompt',
        '- cron: 0 10 * * *',
        '',
        '### Good',
        '- cron: 0 11 * * *',
        '- prompt: do it',
        '',
      ].join('\n')
    );
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile();

    // Only the "Good" task registers.
    expect(cronService.scheduleCron).toHaveBeenCalledTimes(1);
    expect(cronService.scheduleCron.mock.calls[0][0]).toBe('0 11 * * *');
  });

  it('cleans up previously registered jobs on reload', async () => {
    writeHeartbeat(['### T', '- cron: 0 9 * * *', '- prompt: p', ''].join('\n'));
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile();
    expect(cronService.scheduleCron).toHaveBeenCalledTimes(1);

    await loader.loadFromFile(); // second load should delete the first job before re-registering
    expect(cronService.deleteJob).toHaveBeenCalledWith('job-1');
  });

  it('continues when a single task registration fails', async () => {
    cronService.scheduleCron.mockRejectedValueOnce(new Error('schedule failed'));
    writeHeartbeat(['### T', '- cron: 0 9 * * *', '- prompt: p', ''].join('\n'));
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await expect(loader.loadFromFile()).resolves.toBeUndefined();
  });

  it('cleanup deletes all registered jobs and clears the set', async () => {
    writeHeartbeat(['### T', '- cron: 0 9 * * *', '- prompt: p', ''].join('\n'));
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile();
    await loader.cleanup();
    expect(cronService.deleteJob).toHaveBeenCalledWith('job-1');
    // A subsequent cleanup is a no-op (set already cleared).
    cronService.deleteJob.mockClear();
    await loader.cleanup();
    expect(cronService.deleteJob).not.toHaveBeenCalled();
  });
});
