import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAgentWorktreeIsolation } from '../../../src/host/agent/agentWorktree';

describe('external subagent worktree isolation', () => {
  let nonGitDir: string | undefined;

  afterEach(async () => {
    if (nonGitDir) await fs.rm(nonGitDir, { recursive: true, force: true });
    nonGitDir = undefined;
  });

  it('never downgrades a forced external engine to shared cwd outside git', async () => {
    nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-isolation-'));

    expect(resolveAgentWorktreeIsolation({
      tools: ['Read'],
      cwd: nonGitDir,
      forceWorktree: true,
    })).toBe('worktree');
    expect(resolveAgentWorktreeIsolation({
      tools: ['Read'],
      cwd: nonGitDir,
    })).toBe('none');
  });

  it('passes the created worktree cwd into the executor context', async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), 'src/host/agent/multiagentTools/spawnAgent.ts'),
      'utf8',
    );

    expect(source).toContain('const executorContext: SubagentExecutionContext = {\n        ...context, cwd,');
    expect(source).toContain("forceWorktree: engineResolution.engine !== 'native'");
  });
});
