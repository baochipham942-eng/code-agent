import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Re-export the real fs through a configurable namespace so individual tests
// can spyOn specific functions (ESM namespaces are otherwise non-configurable).
// All functions keep their real implementation unless explicitly spied.
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }));
import {
  HeartbeatTaskLoader,
  isWithinActiveHours,
} from '../../../src/host/cron/heartbeatTaskLoader';
import { getProjectConfigDir } from '../../../src/host/config/configPaths';

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
  // CronServiceLike (host/cron/heartbeatTaskLoader.ts) is module-private, so we
  // can't import it; declare the same shape here with real Mock<> call
  // signatures instead of the untyped ReturnType<typeof vi.fn> (which resolves
  // to the fully generic Mock<Constructable | Procedure> and doesn't satisfy
  // the interface's specific 3-arg/1-arg methods).
  let cronService: {
    scheduleCron: Mock<(cron: string, action: unknown, options: { name: string }) => Promise<{ id: string }>>;
    deleteJob: Mock<(jobId: string) => Promise<boolean>>;
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

  it('cleans up registered jobs when HEARTBEAT.md is deleted', async () => {
    // Deleting the file is the user disabling all heartbeat tasks; a reload
    // (e.g. triggered by the file watcher) must remove the stale cron jobs.
    writeHeartbeat(['### T', '- cron: 0 9 * * *', '- prompt: p', ''].join('\n'));
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile();
    expect(cronService.scheduleCron).toHaveBeenCalledTimes(1);

    fs.rmSync(path.join(getProjectConfigDir(workingDirectory), 'HEARTBEAT.md'));
    await loader.loadFromFile(); // file gone → must clean up job-1
    expect(cronService.deleteJob).toHaveBeenCalledWith('job-1');
  });

  it('cleans up stale jobs when the file vanishes between existsSync and read (TOCTOU)', async () => {
    writeHeartbeat(['### T', '- cron: 0 9 * * *', '- prompt: p', ''].join('\n'));
    const loader = new HeartbeatTaskLoader({ workingDirectory, cronService });
    await loader.loadFromFile(); // registers job-1

    // Race: existsSync passes, then the file is gone by readFileSync time.
    fs.rmSync(path.join(getProjectConfigDir(workingDirectory), 'HEARTBEAT.md'));
    vi.spyOn(fs, 'existsSync').mockReturnValueOnce(true); // only the guard call
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await loader.loadFromFile();
    expect(cronService.deleteJob).toHaveBeenCalledWith('job-1');
    vi.restoreAllMocks();
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
