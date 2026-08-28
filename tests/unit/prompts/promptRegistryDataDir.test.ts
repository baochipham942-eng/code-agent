import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
});
