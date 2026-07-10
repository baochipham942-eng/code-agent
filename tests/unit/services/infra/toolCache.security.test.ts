import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: vi.fn(() => {
    throw new Error('fail-closed cache policy must not access persistence');
  }),
}));

import {
  normalizeToolCacheScope,
  ToolCache,
} from '../../../../src/host/services/infra/toolCache';

const RESULT = {
  toolCallId: 'tool-result',
  success: true,
  output: 'executed',
};

const UNCACHEABLE_TOOLS = [
  'Bash',
  'bash',
  'Write',
  'write_file',
  'Edit',
  'edit_file',
  'Task',
  'AgentSpawn',
  'spawn_agent',
  'workflow',
  'mcp_add_server',
  'unknown_side_effect',
  'Read',
  'read_file',
  'ListDirectory',
  'Glob',
  'Grep',
  'web_fetch',
];

describe('ToolCache execution safety', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(UNCACHEABLE_TOOLS)('%s is fail-closed and repeated calls execute twice', (toolName) => {
    const cache = new ToolCache({ persistentCache: false });
    const scope = { sessionId: 'session-a', workingDirectory: '/workspace/a' };
    const args = { value: 'same-input' };
    let executions = 0;

    const invoke = () => {
      const cached = cache.get(toolName, args, scope);
      if (cached) return cached;
      executions += 1;
      cache.set(toolName, args, RESULT, scope);
      return RESULT;
    };

    invoke();
    invoke();

    expect(cache.isCacheable(toolName)).toBe(false);
    expect(executions).toBe(2);
    expect(cache.getStats().totalEntries).toBe(0);
  });

  it('normalizes symlink and dot-segment workspace aliases to one identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-cache-workspace-'));
    tempDirs.push(root);
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, 'dir');

    const direct = normalizeToolCacheScope({
      sessionId: 'session-a',
      workingDirectory: `${workspace}/.`,
    });
    const throughAlias = normalizeToolCacheScope({
      sessionId: 'session-a',
      workingDirectory: alias,
    });

    expect(direct).not.toBeNull();
    expect(throughAlias).not.toBeNull();
    expect(throughAlias?.workspaceIdentity).toBe(direct?.workspaceIdentity);
    expect(throughAlias?.cacheNamespace).toBe(direct?.cacheNamespace);
    expect(throughAlias?.memoryScopeKey).toBe(direct?.memoryScopeKey);
  });

  it('binds the in-memory scope to both workspace and session and rejects missing scope', () => {
    const workspaceA = mkdtempSync(join(tmpdir(), 'tool-cache-scope-a-'));
    const workspaceB = mkdtempSync(join(tmpdir(), 'tool-cache-scope-b-'));
    tempDirs.push(workspaceA, workspaceB);

    const sessionA = normalizeToolCacheScope({ sessionId: 'session-a', workingDirectory: workspaceA });
    const sessionB = normalizeToolCacheScope({ sessionId: 'session-b', workingDirectory: workspaceA });
    const workspaceBIdentity = normalizeToolCacheScope({ sessionId: 'session-a', workingDirectory: workspaceB });

    expect(sessionA?.memoryScopeKey).not.toBe(sessionB?.memoryScopeKey);
    expect(sessionA?.memoryScopeKey).not.toBe(workspaceBIdentity?.memoryScopeKey);
    expect(normalizeToolCacheScope({ sessionId: 'session-a' })).toBeNull();
    expect(normalizeToolCacheScope({ workingDirectory: workspaceA })).toBeNull();
    expect(normalizeToolCacheScope({
      sessionId: 'session-a',
      workingDirectory: join(workspaceA, 'missing'),
    })).toBeNull();
  });
});
