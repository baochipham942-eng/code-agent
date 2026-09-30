import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
