import os from 'os';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWebServiceMode,
  resolveDevAuthTokenPath,
  writeDevAuthToken,
} from '../../../src/web/middleware/auth';

/**
 * 服务态 token 是在模块加载那一刻定下来的（SERVER_AUTH_TOKEN 是模块级常量，缺 token 就在
 * import 阶段抛）。解析函数本身不导出——只给单测 import 的导出会被生产死导出棘轮判红——
 * 所以这里按注入的 env 重载模块，直接验「import 会不会炸」和「拿到的 token 是什么」，
 * 这也正是生产里真实发生的形态。
 */
async function loadAuthWithEnv(env: Record<string, string | undefined>) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  try {
    return await import('../../../src/web/middleware/auth');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

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

describe('service auth token', () => {
  it('fails closed when service mode has no injected token', async () => {
    await expect(loadAuthWithEnv({
      CODE_AGENT_SERVICE_MODE: '1',
      CODE_AGENT_WEB_AUTH_TOKEN: undefined,
      CODE_AGENT_TAURI_BOOT_TOKEN: undefined,
    })).rejects.toThrow('CODE_AGENT_WEB_AUTH_TOKEN is required');
  });

  it('uses the injected token only in explicit service mode', async () => {
    expect(isWebServiceMode({
      CODE_AGENT_SERVICE_MODE: '1',
      CODE_AGENT_WEB_AUTH_TOKEN: 'service-secret-token',
    } as NodeJS.ProcessEnv)).toBe(true);

    const serviceAuth = await loadAuthWithEnv({
      CODE_AGENT_SERVICE_MODE: '1',
      CODE_AGENT_WEB_AUTH_TOKEN: '  service-secret-token  ',
      CODE_AGENT_TAURI_BOOT_TOKEN: undefined,
    });
    expect(serviceAuth.SERVER_AUTH_TOKEN).toBe('service-secret-token');
  });

  it('rejects the Tauri parent-process contract in service mode', async () => {
    await expect(loadAuthWithEnv({
      CODE_AGENT_SERVICE_MODE: '1',
      CODE_AGENT_WEB_AUTH_TOKEN: 'service-secret-token',
      CODE_AGENT_TAURI_BOOT_TOKEN: 'desktop-parent-token',
    })).rejects.toThrow('cannot be combined with CODE_AGENT_TAURI_BOOT_TOKEN');
  });
});
