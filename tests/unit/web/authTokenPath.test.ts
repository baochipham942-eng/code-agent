import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDevAuthTokenPath } from '../../../src/web/middleware/auth';

const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.CODE_AGENT_DATA_DIR;
  } else {
    process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  }
});

describe('resolveDevAuthTokenPath', () => {
  it('keeps the dev token in cwd for local development', () => {
    delete process.env.CODE_AGENT_DATA_DIR;

    expect(resolveDevAuthTokenPath('/repo/code-agent')).toBe('/repo/code-agent/.dev-token');
  });

  it('moves the token out of a packaged macOS app bundle', () => {
    process.env.CODE_AGENT_DATA_DIR = '/Users/test/.code-agent';
    const packagedCwd = path.join(
      '/Applications',
      'Code Agent.app',
      'Contents',
      'Resources',
      '_up_',
    );

    expect(resolveDevAuthTokenPath(packagedCwd)).toBe('/Users/test/.code-agent/.dev-token');
  });

  it('falls back to the user data directory when CODE_AGENT_DATA_DIR is absent', () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    const packagedCwd = path.join(
      '/Applications',
      'Code Agent.app',
      'Contents',
      'Resources',
    );

    expect(resolveDevAuthTokenPath(packagedCwd)).toBe(path.join(os.homedir(), '.code-agent', '.dev-token'));
  });
});
