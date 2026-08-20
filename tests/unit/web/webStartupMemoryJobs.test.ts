import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    listJobs: mocks.listJobs,
    createJob: mocks.createJob,
    updateJob: mocks.updateJob,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import { MEMORY_CONSOLIDATION } from '../../../src/shared/constants/memory';
import { registerMemoryConsolidationJob } from '../../../src/web/webStartupMemoryJobs';

describe('registerMemoryConsolidationJob', () => {
  beforeEach(() => {
    mocks.listJobs.mockReset();
    mocks.createJob.mockReset().mockResolvedValue({});
    mocks.updateJob.mockReset().mockResolvedValue({});
  });

  it('registers new scheduled consolidation in live mode', async () => {
    mocks.listJobs.mockReturnValue([]);

    await registerMemoryConsolidationJob();

    expect(MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT).toBe(false);
    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'memory-consolidation', dryRun: false },
      tags: [MEMORY_CONSOLIDATION.JOB_TAG],
    }));
  });

  it('upgrades an existing dry-run job instead of leaving the old action stale', async () => {
    mocks.listJobs.mockReturnValue([{
      id: 'memory-job',
      action: { type: 'memory-consolidation', dryRun: true },
    }]);

    await registerMemoryConsolidationJob();

    expect(mocks.updateJob).toHaveBeenCalledWith('memory-job', {
      action: { type: 'memory-consolidation', dryRun: false },
    });
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
});
