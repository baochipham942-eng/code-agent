import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    listJobs: mocks.listJobs,
    createJob: mocks.createJob,
    updateJob: mocks.updateJob,
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: mocks.getSettings,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import { MEMORY_CONSOLIDATION } from '../../../src/shared/constants/memory';
import { syncMemoryConsolidationJob } from '../../../src/host/lightMemory/consolidationJobSync';
import { registerMemoryConsolidationJob } from '../../../src/web/webStartupMemoryJobs';

describe('syncMemoryConsolidationJob', () => {
  beforeEach(() => {
    mocks.listJobs.mockReset();
    mocks.createJob.mockReset().mockResolvedValue({});
    mocks.updateJob.mockReset().mockResolvedValue({});
    mocks.getSettings.mockReset().mockReturnValue({});
  });

  it('creates the job in dry-run mode when auto-consolidate is off', async () => {
    mocks.listJobs.mockReturnValue([]);

    await syncMemoryConsolidationJob(false);

    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'memory-consolidation', dryRun: true },
      tags: [MEMORY_CONSOLIDATION.JOB_TAG],
    }));
    expect(mocks.updateJob).not.toHaveBeenCalled();
  });

  it('creates the job in real-write mode when auto-consolidate is on', async () => {
    mocks.listJobs.mockReturnValue([]);

    await syncMemoryConsolidationJob(true);

    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'memory-consolidation', dryRun: false },
    }));
  });

  it('leaves an existing job untouched when dryRun already matches', async () => {
    mocks.listJobs.mockReturnValue([{
      id: 'memory-job',
      action: { type: 'memory-consolidation', dryRun: true },
    }]);

    await syncMemoryConsolidationJob(false);

    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('upgrades an existing dry-run job when the user turns auto-consolidate on', async () => {
    mocks.listJobs.mockReturnValue([{
      id: 'memory-job',
      action: { type: 'memory-consolidation', dryRun: true },
    }]);

    await syncMemoryConsolidationJob(true);

    expect(mocks.updateJob).toHaveBeenCalledWith('memory-job', {
      action: { type: 'memory-consolidation', dryRun: false },
    });
  });

  it('downgrades an existing real-write job when the user turns auto-consolidate off', async () => {
    mocks.listJobs.mockReturnValue([{
      id: 'memory-job',
      action: { type: 'memory-consolidation', dryRun: false },
    }]);

    await syncMemoryConsolidationJob(false);

    expect(mocks.updateJob).toHaveBeenCalledWith('memory-job', {
      action: { type: 'memory-consolidation', dryRun: true },
    });
  });
});

describe('registerMemoryConsolidationJob', () => {
  beforeEach(() => {
    mocks.listJobs.mockReset();
    mocks.createJob.mockReset().mockResolvedValue({});
    mocks.updateJob.mockReset().mockResolvedValue({});
    mocks.getSettings.mockReset();
  });

  it('registers in dry-run mode when settings have no memory section', async () => {
    mocks.getSettings.mockReturnValue({});
    mocks.listJobs.mockReturnValue([]);

    await registerMemoryConsolidationJob();

    expect(MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT).toBe(true);
    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'memory-consolidation', dryRun: true },
      tags: [MEMORY_CONSOLIDATION.JOB_TAG],
    }));
  });

  it('registers in real-write mode when the user enabled auto-consolidate', async () => {
    mocks.getSettings.mockReturnValue({ memory: { autoConsolidate: true } });
    mocks.listJobs.mockReturnValue([]);

    await registerMemoryConsolidationJob();

    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'memory-consolidation', dryRun: false },
    }));
  });

  it('swallows sync errors so startup never breaks', async () => {
    mocks.getSettings.mockImplementation(() => { throw new Error('config not ready'); });

    await expect(registerMemoryConsolidationJob()).resolves.toBeUndefined();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
});
