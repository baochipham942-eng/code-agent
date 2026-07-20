import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('child_process', async (importActual) => ({
  ...(await importActual<typeof import('child_process')>()),
  execFile: childProcessMocks.execFile,
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp/code-agent-lab-service-cause-test' },
  AppWindow: class {},
}));

import { LabService } from '../../../src/host/services/lab/LabService';

describe('LabService inference error identity', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
  });

  it('rethrows the original inference error', async () => {
    const originalError = new Error('python inference failed');
    childProcessMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(originalError, '', 'stderr');
    });
    const service = new LabService() as unknown as {
      getProjectPath(projectType: 'gpt1'): string;
      inference(request: {
        projectType: 'gpt1';
        prompt: string;
      }): Promise<unknown>;
    };
    vi.spyOn(service, 'getProjectPath').mockReturnValue('/tmp');

    const error = await service.inference({ projectType: 'gpt1', prompt: 'hello' })
      .catch((caught: unknown) => caught);

    expect(error).toBe(originalError);
  });
});
