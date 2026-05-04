import os from 'os';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDevAuthTokenPath, writeDevAuthToken } from '../../../src/web/middleware/auth';

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

  it('mirrors packaged tokens into the repo root for the Vite dev renderer', () => {
    const repoRoot = process.cwd();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-token-'));
    const originalToken = fs.existsSync(path.join(repoRoot, '.dev-token'))
      ? fs.readFileSync(path.join(repoRoot, '.dev-token'), 'utf-8')
      : null;
    process.env.CODE_AGENT_DATA_DIR = dataDir;

    try {
      const packagedCwd = path.join('/Applications', 'Code Agent.app', 'Contents', 'Resources');
      writeDevAuthToken('11111111-1111-4111-8111-111111111111', packagedCwd);

      expect(fs.readFileSync(path.join(dataDir, '.dev-token'), 'utf-8')).toBe('11111111-1111-4111-8111-111111111111');
      expect(fs.readFileSync(path.join(repoRoot, '.dev-token'), 'utf-8')).toBe('11111111-1111-4111-8111-111111111111');
    } finally {
      if (originalToken === null) {
        try { fs.unlinkSync(path.join(repoRoot, '.dev-token')); } catch { /* ignore */ }
      } else {
        fs.writeFileSync(path.join(repoRoot, '.dev-token'), originalToken, 'utf-8');
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
