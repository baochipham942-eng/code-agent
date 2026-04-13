// ============================================================================
// AgentWorktree Tests
// 覆盖 create/cleanup/orphaned worktrees 的边界行为
// mock child_process.exec 避免触碰真实 git
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock child_process.exec — 通过 promisify.custom 提供 {stdout, stderr} 返回值
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr?: string;
}

const execState = vi.hoisted(() => {
  const handlers: Array<{
    pattern: RegExp;
    respond: (cmd: string) => ExecResult | Promise<ExecResult>;
  }> = [];
  const calls: string[] = [];
  return {
    handlers,
    calls,
    reset() {
      handlers.length = 0;
      calls.length = 0;
    },
    when(
      pattern: RegExp,
      respond: (cmd: string) => ExecResult | Promise<ExecResult>
    ) {
      handlers.push({ pattern, respond });
    },
    async run(cmd: string): Promise<ExecResult> {
      calls.push(cmd);
      for (const { pattern, respond } of handlers) {
        if (pattern.test(cmd)) {
          return await respond(cmd);
        }
      }
      return { stdout: '', stderr: '' };
    },
  };
});

vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const util = require('util');
  const exec: {
    (cmd: string, opts: unknown, cb?: unknown): void;
    [key: symbol]: unknown;
  } = ((cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      stdout: string,
      stderr: string
    ) => void;
    execState
      .run(cmd)
      .then((r) => callback(null, r.stdout, r.stderr ?? ''))
      .catch((err: Error) => callback(err, '', ''));
  }) as unknown as typeof exec;
  exec[util.promisify.custom] = async (cmd: string) => {
    return await execState.run(cmd);
  };
  return { exec };
});

// ---------------------------------------------------------------------------
// Mock fs.statSync for orphan cleanup mtime check
// ---------------------------------------------------------------------------

const fsState = vi.hoisted(() => {
  const mtimes = new Map<string, number>();
  return {
    mtimes,
    reset() {
      mtimes.clear();
    },
    setMtime(p: string, ms: number) {
      mtimes.set(p, ms);
    },
  };
});

vi.mock('fs', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: (p: string) => {
      const ms = fsState.mtimes.get(p);
      if (ms === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return { mtimeMs: ms } as import('fs').Stats;
    },
  };
});

import {
  createAgentWorktree,
  cleanupAgentWorktree,
  cleanupOrphanedWorktrees,
} from '../../../src/main/agent/agentWorktree';

describe('AgentWorktree', () => {
  beforeEach(() => {
    execState.reset();
    fsState.reset();
  });

  // ==========================================================================
  // createAgentWorktree
  // ==========================================================================

  describe('createAgentWorktree', () => {
    it('生成标准分支名 agent/<id> 和路径', async () => {
      execState.when(/git worktree add/, () => ({ stdout: '' }));

      const info = await createAgentWorktree('agent-1', '/repo');

      expect(info.branchName).toBe('agent/agent-1');
      expect(info.worktreePath).toBe('/tmp/code-agent-worktrees/agent-1');
      expect(execState.calls.some((c) => c.includes("git worktree add -b 'agent/agent-1'"))).toBe(
        true
      );
    });

    it('无 baseBranch 时以 HEAD 为 base', async () => {
      execState.when(/git worktree add/, () => ({ stdout: '' }));

      await createAgentWorktree('a1', '/repo');

      const cmd = execState.calls[0];
      expect(cmd).toMatch(/'HEAD'$/);
    });

    it('传入 baseBranch 时使用该分支', async () => {
      execState.when(/git worktree add/, () => ({ stdout: '' }));

      await createAgentWorktree('a1', '/repo', 'main');

      const cmd = execState.calls[0];
      expect(cmd).toMatch(/'main'$/);
    });

    it('agentId 含特殊字符时路径被 sanitize', async () => {
      execState.when(/git worktree add/, () => ({ stdout: '' }));

      const info = await createAgentWorktree('task/xyz:1', '/repo');

      expect(info.worktreePath).toBe('/tmp/code-agent-worktrees/task_xyz_1');
      // 注意：branchName 使用原始 id（未 sanitize），这是源码当前行为
      expect(info.branchName).toBe('agent/task/xyz:1');
    });

    it('git worktree add 失败时向上抛出', async () => {
      execState.when(/git worktree add/, () => {
        throw new Error('worktree already exists');
      });

      await expect(createAgentWorktree('a1', '/repo')).rejects.toThrow('worktree already exists');
    });
  });

  // ==========================================================================
  // cleanupAgentWorktree
  // ==========================================================================

  describe('cleanupAgentWorktree', () => {
    it('无变更时删除 worktree 和分支', async () => {
      execState.when(/git -C .* status --porcelain/, () => ({ stdout: '' }));
      execState.when(/git -C .* diff HEAD/, () => ({ stdout: '' }));
      execState.when(/git worktree remove/, () => ({ stdout: '' }));
      execState.when(/git branch -d/, () => ({ stdout: '' }));

      const result = await cleanupAgentWorktree('a1', '/tmp/wt/a1', '/repo');

      expect(result.hasChanges).toBe(false);
      expect(result.branchName).toBe('agent/a1');
      expect(result.worktreePath).toBeUndefined();
      expect(execState.calls.some((c) => c.includes('git worktree remove'))).toBe(true);
      expect(execState.calls.some((c) => c.includes("git branch -d 'agent/a1'"))).toBe(true);
    });

    it('有未提交变更时保留 worktree', async () => {
      execState.when(/status --porcelain/, () => ({ stdout: ' M src/foo.ts\n' }));
      execState.when(/diff HEAD/, () => ({ stdout: '' }));

      const result = await cleanupAgentWorktree('a1', '/tmp/wt/a1', '/repo');

      expect(result.hasChanges).toBe(true);
      expect(result.worktreePath).toBe('/tmp/wt/a1');
      // 不应调用 remove
      expect(execState.calls.some((c) => c.includes('git worktree remove'))).toBe(false);
    });

    it('有 diff 也判为 hasChanges=true', async () => {
      execState.when(/status --porcelain/, () => ({ stdout: '' }));
      execState.when(/diff HEAD/, () => ({ stdout: ' src/foo.ts | 2 ++\n' }));

      const result = await cleanupAgentWorktree('a1', '/tmp/wt/a1', '/repo');

      expect(result.hasChanges).toBe(true);
    });

    it('分支删除失败不影响整体清理结果', async () => {
      execState.when(/status --porcelain/, () => ({ stdout: '' }));
      execState.when(/diff HEAD/, () => ({ stdout: '' }));
      execState.when(/git worktree remove/, () => ({ stdout: '' }));
      execState.when(/git branch -d/, () => {
        throw new Error('branch not fully merged');
      });

      const result = await cleanupAgentWorktree('a1', '/tmp/wt/a1', '/repo');

      expect(result.hasChanges).toBe(false);
    });

    it('status 抛错时走 force 清理兜底并返回 hasChanges=false', async () => {
      execState.when(/status --porcelain/, () => {
        throw new Error('not a git repository');
      });
      execState.when(/git worktree remove --force/, () => ({ stdout: '' }));
      execState.when(/git branch -D/, () => ({ stdout: '' }));

      const result = await cleanupAgentWorktree('a1', '/tmp/wt/a1', '/repo');

      expect(result.hasChanges).toBe(false);
      expect(
        execState.calls.some((c) => c.includes('git worktree remove --force'))
      ).toBe(true);
    });
  });

  // ==========================================================================
  // cleanupOrphanedWorktrees
  // ==========================================================================

  describe('cleanupOrphanedWorktrees', () => {
    const makeWorktreeList = (blocks: string[]) => blocks.join('\n\n');

    it('识别并清理基目录下的过期 worktree', async () => {
      const now = Date.now();
      fsState.setMtime('/tmp/code-agent-worktrees/old', now - 2 * 3600_000);

      execState.when(/git worktree list/, () => ({
        stdout: makeWorktreeList([
          'worktree /tmp/code-agent-worktrees/old\nbranch refs/heads/agent/old',
        ]),
      }));
      execState.when(/git worktree remove --force/, () => ({ stdout: '' }));
      execState.when(/git branch -D/, () => ({ stdout: '' }));

      const cleaned = await cleanupOrphanedWorktrees('/repo', 3600_000);

      expect(cleaned).toBe(1);
      expect(
        execState.calls.some((c) =>
          c.includes("git worktree remove --force '/tmp/code-agent-worktrees/old'")
        )
      ).toBe(true);
      expect(execState.calls.some((c) => c.includes("git branch -D 'agent/old'"))).toBe(true);
    });

    it('跳过不在基目录下的 worktree', async () => {
      const now = Date.now();
      fsState.setMtime('/home/user/other', now - 2 * 3600_000);

      execState.when(/git worktree list/, () => ({
        stdout: makeWorktreeList(['worktree /home/user/other\nbranch refs/heads/feature/x']),
      }));

      const cleaned = await cleanupOrphanedWorktrees('/repo', 3600_000);

      expect(cleaned).toBe(0);
      expect(execState.calls.some((c) => c.includes('remove --force'))).toBe(false);
    });

    it('跳过 mtime 未超期的 worktree', async () => {
      const now = Date.now();
      fsState.setMtime('/tmp/code-agent-worktrees/fresh', now - 60_000);

      execState.when(/git worktree list/, () => ({
        stdout: makeWorktreeList([
          'worktree /tmp/code-agent-worktrees/fresh\nbranch refs/heads/agent/fresh',
        ]),
      }));

      const cleaned = await cleanupOrphanedWorktrees('/repo', 3600_000);

      expect(cleaned).toBe(0);
    });

    it('目录已消失（stat 抛错）仍强制清理 git 引用', async () => {
      // 不 setMtime — statSync 会抛
      execState.when(/git worktree list/, () => ({
        stdout: makeWorktreeList([
          'worktree /tmp/code-agent-worktrees/ghost\nbranch refs/heads/agent/ghost',
        ]),
      }));
      execState.when(/git worktree remove --force/, () => ({ stdout: '' }));
      execState.when(/git branch -D/, () => ({ stdout: '' }));

      const cleaned = await cleanupOrphanedWorktrees('/repo', 3600_000);

      expect(cleaned).toBe(1);
    });

    it('非 agent/* 分支不会被 branch -D', async () => {
      const now = Date.now();
      fsState.setMtime('/tmp/code-agent-worktrees/manual', now - 2 * 3600_000);

      execState.when(/git worktree list/, () => ({
        stdout: makeWorktreeList([
          'worktree /tmp/code-agent-worktrees/manual\nbranch refs/heads/manual-branch',
        ]),
      }));
      execState.when(/git worktree remove --force/, () => ({ stdout: '' }));

      const cleaned = await cleanupOrphanedWorktrees('/repo', 3600_000);

      expect(cleaned).toBe(1);
      expect(execState.calls.some((c) => c.includes('branch -D'))).toBe(false);
    });

    it('git worktree list 失败时返回 0 而不抛错', async () => {
      execState.when(/git worktree list/, () => {
        throw new Error('not a git repo');
      });

      const cleaned = await cleanupOrphanedWorktrees('/repo');

      expect(cleaned).toBe(0);
    });
  });
});
