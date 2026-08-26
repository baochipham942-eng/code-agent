import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadKeytar } from '../../../../src/host/services/core/keytarAdapter';

describe('keytarAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips the native module in pure CLI mode', () => {
    vi.stubEnv('CODE_AGENT_CLI_MODE', 'true');
    vi.stubEnv('CODE_AGENT_WEB_MODE', '');
    const loader = vi.fn();

    expect(loadKeytar(loader)).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads keytar in the desktop web backend', () => {
    vi.stubEnv('CODE_AGENT_CLI_MODE', 'true');
    vi.stubEnv('CODE_AGENT_WEB_MODE', 'true');
    const keytar = {} as typeof import('keytar');
    const loader = vi.fn(() => keytar);

    expect(loadKeytar(loader)).toBe(keytar);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('falls back when keytar cannot be loaded', () => {
    vi.stubEnv('CODE_AGENT_CLI_MODE', '');
    vi.stubEnv('CODE_AGENT_WEB_MODE', '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(loadKeytar(() => { throw new Error('native module unavailable'); })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      '[SecureStorage] keytar not available:',
      'native module unavailable'
    );
  });
});
