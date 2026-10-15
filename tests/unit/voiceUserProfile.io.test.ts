import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const configDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => configDir.dir,
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
}));

vi.mock('../../src/host/platform', () => ({
  app: { isPackaged: false, getPath: () => configDir.dir },
}));
vi.mock('../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({
    getApiKey: vi.fn(() => undefined),
    setApiKey: vi.fn(),
    getSettingsFromKeychain: vi.fn(async () => null),
    saveSettingsToKeychain: vi.fn(async () => undefined),
    getStoredApiKeyProviders: vi.fn(() => []),
  }),
}));
vi.mock('../../src/host/permissions/policyEngine', () => ({
  getPolicyEngine: () => ({ loadUserRules: vi.fn() }),
}));
vi.mock('../../src/host/model/concurrencyLimiter', () => ({ setProviderConcurrencyOverrides: vi.fn() }));
vi.mock('../../src/host/model/providers/shared', () => ({ setProviderProxyOverrides: vi.fn() }));

const { loadVoiceUserProfile } = await import('../../src/host/services/voice/voiceUserProfile');

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'voice-user-profile-'));
  configDir.dir = tmpDir;
  await mkdir(path.join(tmpDir, 'memory'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('voice user profile real Light Memory I/O', () => {
  it('loads 200 fixture files from a real memory directory under 200 ms', async () => {
    const memoryDir = path.join(tmpDir, 'memory');
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(
      path.join(memoryDir, `user-${index}.md`),
      `---\nname: User ${index}\ndescription: User profile ${index}\ntype: user\nstatus: active\nscope: global\n---\n\nUser profile ${index}\n`,
      'utf8',
    )));

    const startedAt = performance.now();
    const block = await loadVoiceUserProfile();
    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(block).toContain('[Context — User profile]');
    expect(block.match(/^- /gmu)).toHaveLength(8);
  });

  it('returns empty when the memory directory is unreadable or absent', async () => {
    await rm(path.join(tmpDir, 'memory'), { recursive: true, force: true });
    await expect(loadVoiceUserProfile()).resolves.toBe('');
  });
});


it('injects genuine facts and the two latest project titles, never operations or persona memories', async () => {
  const memoryDir = path.join(tmpDir, 'memory');
  await cp(path.resolve('tests/fixtures/voice-profile-memory'), memoryDir, { recursive: true });
  for (const [name, time] of [
    ['project-old.md', '2026-10-01'],
    ['project-exhibit.md', '2026-10-12'],
    ['project-catalog.md', '2026-10-14'],
  ]) await utimes(path.join(memoryDir, name), new Date(time), new Date(time));
  const block = await loadVoiceUserProfile();
  expect(block).toContain('用户从事博物馆策展工作');
  expect(block).toContain('用户偏好简体中文和简短说明');
  expect(block).toContain('最近在做：秋季展览图录、海洋主题展');
  expect(block).not.toMatch(/ROLE_SENTINEL|INTIMACY_SENTINEL|SOUL_SENTINEL|OPERATION_SENTINEL|TYPED_PERSONA_SENTINEL/);
  expect(block).not.toContain('PROJECT_BODY_SENTINEL');
  expect(block).not.toContain('往期展览');
  expect(block.length).toBeLessThanOrEqual(600);
});


it('persists profile edits and off across reload, preserves sibling settings, and resets with null', async () => {
  // Exercise real ConfigService disk persistence; profile loader tests above use
  // the empty-settings stub so they remain focused on the real memory directory.
  const { ConfigService } = await vi.importActual<typeof import('../../src/host/services/core/configService')>(
    '../../src/host/services/core/configService',
  );
  const service = new ConfigService();
  await service.initialize();
  await service.updateSettings({ voice: { userProfile: { enabled: false, override: '用户负责展览策划。' } } });
  await service.updateSettings({ voice: { live: { language: 'zh' } } });
  const reloaded = new ConfigService();
  await reloaded.initialize();
  expect(reloaded.getSettings().voice?.userProfile).toEqual({ enabled: false, override: '用户负责展览策划。' });
  expect(reloaded.getSettings().voice?.live?.language).toBe('zh');
  await reloaded.updateSettings({ voice: { userProfile: { enabled: true, override: null } } });
  const reset = new ConfigService();
  await reset.initialize();
  expect(reset.getSettings().voice?.userProfile).toEqual({ enabled: true, override: null });
});
