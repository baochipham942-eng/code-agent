import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('prompt override data directory', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('stores overrides below CODE_AGENT_DATA_DIR', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'prompt-data-dir-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', tempDir);
    vi.resetModules();
    const registry = await import('../../../src/host/prompts/registry');
    registry.applyOverride(
      { id: 'data-dir-proof', category: 'Test', name: 'Data dir proof' },
      'default',
    );

    registry.setPromptOverride('data-dir-proof', 'isolated override');

    const overridePath = path.join(tempDir, 'prompts-overrides', 'data-dir-proof.md');
    await expect(readFile(overridePath, 'utf8')).resolves.toBe('isolated override');
  });

  it('已注册的 prompt 切目录后写入新目录，内存 override 也按目录隔离', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'prompt-switch-'));
    const oldDir = path.join(tempDir, 'old');
    const newDir = path.join(tempDir, 'new');
    await mkdir(oldDir);
    await mkdir(newDir);
    vi.stubEnv('CODE_AGENT_DATA_DIR', oldDir);
    vi.resetModules();
    const registry = await import('../../../src/host/prompts/registry');
    const live = registry.applyOverride({ id: 'switch-proof', category: 'Test', name: 'Switch' }, 'default');
    vi.stubEnv('CODE_AGENT_DATA_DIR', newDir);
    registry.setPromptOverride('switch-proof', 'new override');
    expect(await readFile(path.join(newDir, 'prompts-overrides/switch-proof.md'), 'utf8')).toBe('new override');
    expect(await readdir(oldDir)).toEqual([]);
    expect(String(live)).toBe('new override');
    vi.stubEnv('CODE_AGENT_DATA_DIR', oldDir);
    expect(String(live)).toBe('default');
    expect(registry.getPromptDetail('switch-proof')?.override).toBeNull();
    vi.stubEnv('CODE_AGENT_DATA_DIR', newDir);
    expect(registry.lookupPromptText('switch-proof')).toBe('new override');
    registry.resetPromptOverride('switch-proof');
    expect(await readdir(path.join(newDir, 'prompts-overrides'))).toEqual([]);
  });

});
