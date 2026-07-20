import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  exec: vi.fn(),
}));

vi.mock('child_process', async (importActual) => ({
  ...(await importActual<typeof import('child_process')>()),
  exec: childProcessMocks.exec,
}));

import { HeartbeatService } from '../../../src/host/cron/heartbeatService';

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

describe('HeartbeatService shell error cause', () => {
  beforeEach(() => {
    childProcessMocks.exec.mockReset();
  });

  it('preserves the command error when wrapping a failed shell check', async () => {
    const originalError = Object.assign(new Error('shell command failed'), { code: 2 });
    childProcessMocks.exec.mockImplementation((_command, _options, callback) => {
      callback(originalError, '', 'stderr');
    });
    const service = new HeartbeatService() as unknown as {
      executeCheck(check: { type: 'shell'; command: string }): Promise<unknown>;
    };

    const error = await captureError(
      service.executeCheck({ type: 'shell', command: 'false' }),
    );

    expect(error.message).toBe('shell command failed');
    expect(error.cause).toBe(originalError);
  });
});
