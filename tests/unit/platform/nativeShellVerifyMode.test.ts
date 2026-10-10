import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecDetached: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('../../../src/host/utils/safeShell', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/utils/safeShell')>(
    '../../../src/host/utils/safeShell',
  );
  return { ...actual, safeExecDetached: mocks.safeExecDetached };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { openExternal } from '../../../src/host/platform/nativeShell';

const originalVerifyMode = process.env.NEO_VERIFY_NO_FOREGROUND;
const originalPlatform = process.platform;

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

beforeEach(() => {
  delete process.env.NEO_VERIFY_NO_FOREGROUND;
  mocks.safeExecDetached.mockReset();
  mocks.logInfo.mockReset();
  setProcessPlatform('darwin');
});

afterEach(() => {
  if (originalVerifyMode === undefined) delete process.env.NEO_VERIFY_NO_FOREGROUND;
  else process.env.NEO_VERIFY_NO_FOREGROUND = originalVerifyMode;
  setProcessPlatform(originalPlatform);
});

describe('openExternal verification mode', () => {
  const url = 'https://auth.example.com/oauth/authorize?code=secret-value';

  it('logs only the origin and does not spawn an opener in verification mode', async () => {
    process.env.NEO_VERIFY_NO_FOREGROUND = '1';

    await openExternal(url);

    expect(mocks.safeExecDetached).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(mocks.logInfo.mock.calls[0]);
    expect(loggedText).toContain('https://auth.example.com');
    expect(loggedText).not.toContain('oauth/authorize');
    expect(loggedText).not.toContain('code=secret-value');
  });

  it('keeps the default macOS opener behavior when verification mode is unset', async () => {
    await openExternal(url);

    expect(mocks.safeExecDetached).toHaveBeenCalledTimes(1);
    expect(mocks.safeExecDetached).toHaveBeenCalledWith('open', [url]);
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it.each(['1', undefined])('still rejects unsafe URL schemes when verification mode is %s', async (mode) => {
    if (mode === undefined) delete process.env.NEO_VERIFY_NO_FOREGROUND;
    else process.env.NEO_VERIFY_NO_FOREGROUND = mode;

    await expect(openExternal('javascript:alert(1)')).rejects.toThrow('Unsafe URL scheme: javascript:');
    expect(mocks.safeExecDetached).not.toHaveBeenCalled();
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });
});
