import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentsDiscoveryCache,
  discoverAgentFilesCached,
} from '../../../src/host/context/agentsDiscovery';

describe('agentsDiscovery', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-discovery-'));
    clearAgentsDiscoveryCache();
  });

  afterEach(async () => {
    clearAgentsDiscoveryCache();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('applies maxDepth before traversing nested instruction files', async () => {
    await writeFile(join(rootDir, 'AGENTS.md'), '# Root');
    await mkdir(join(rootDir, 'one', 'two'), { recursive: true });
    await writeFile(join(rootDir, 'one', 'AGENTS.md'), '# One');
    await writeFile(join(rootDir, 'one', 'two', 'AGENTS.md'), '# Two');

    const result = await discoverAgentFilesCached(rootDir, {
      maxDepth: 1,
      maxFiles: 10,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual([
      'AGENTS.md',
      join('one', 'AGENTS.md'),
    ]);
  });

  it('also loads CLAUDE.md when AGENTS.md is sparse (< 500 chars, roadmap 1.10)', async () => {
    await writeFile(join(rootDir, 'AGENTS.md'), '# Thin\nSee CLAUDE.md');
    await writeFile(join(rootDir, 'CLAUDE.md'), '# Full project guidance\n' + 'rule\n'.repeat(50));

    const result = await discoverAgentFilesCached(rootDir, { maxDepth: 1, maxFiles: 10 });

    expect(result.files.map((file) => file.relativePath)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    expect(result.combinedInstructions).toContain('Full project guidance');
  });

  it('does not load CLAUDE.md when AGENTS.md is substantial', async () => {
    await writeFile(join(rootDir, 'AGENTS.md'), '# Rich\n' + 'a detailed project rule line\n'.repeat(30));
    await writeFile(join(rootDir, 'CLAUDE.md'), '# Legacy guidance');

    const result = await discoverAgentFilesCached(rootDir, { maxDepth: 1, maxFiles: 10 });

    expect(result.files.map((file) => file.relativePath)).toEqual(['AGENTS.md']);
  });

  it('keeps single-file behavior when sparse AGENTS.md has no CLAUDE.md sibling', async () => {
    await writeFile(join(rootDir, 'AGENTS.md'), '# Thin');

    const result = await discoverAgentFilesCached(rootDir, { maxDepth: 1, maxFiles: 10 });

    expect(result.files.map((file) => file.relativePath)).toEqual(['AGENTS.md']);
  });

  it('stops at maxFiles and reports truncation', async () => {
    await writeFile(join(rootDir, 'AGENTS.md'), '# Root');
    await mkdir(join(rootDir, 'one'), { recursive: true });
    await writeFile(join(rootDir, 'one', 'AGENTS.md'), '# One');

    const result = await discoverAgentFilesCached(rootDir, {
      maxDepth: 2,
      maxFiles: 1,
    });

    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
