// ============================================================================
// github_pr (native ToolModule) Tests — P0-6.3 Batch 9
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock child_process.exec (used via promisify)
// -----------------------------------------------------------------------------
// We need to honor util.promisify.custom so that promisify(exec) returns
// { stdout, stderr } as a single value, matching node's real exec promisify.

type ExecResult = { stdout: string; stderr: string };
const execResponses: Array<{ match: string; result?: ExecResult; error?: string }> = [];

function findResponse(cmd: string): { result?: ExecResult; error?: string } | undefined {
  for (const entry of execResponses) {
    if (cmd.includes(entry.match)) return entry;
  }
  return undefined;
}

vi.mock('child_process', async () => {
  const util = await import('util');
  const execImpl = (
    command: string,
    optionsOrCallback?: unknown,
    maybeCallback?: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    const cb =
      typeof optionsOrCallback === 'function'
        ? (optionsOrCallback as typeof maybeCallback)
        : maybeCallback;
    const entry = findResponse(command);
    if (!entry) {
      cb?.(null, '', '');
      return;
    }
    if (entry.error) {
      const err = new Error(entry.error) as Error & { stdout?: string; stderr?: string };
      err.stdout = '';
      err.stderr = entry.error;
      cb?.(err);
      return;
    }
    cb?.(null, entry.result?.stdout ?? '', entry.result?.stderr ?? '');
  };
  // Honor util.promisify.custom so promisify(exec) returns { stdout, stderr }
  (execImpl as unknown as Record<symbol, unknown>)[util.promisify.custom] = (
    command: string,
  ) => {
    return new Promise((resolve, reject) => {
      const entry = findResponse(command);
      if (!entry) {
        resolve({ stdout: '', stderr: '' });
        return;
      }
      if (entry.error) {
        const err = new Error(entry.error) as Error & { stdout?: string; stderr?: string };
        err.stdout = '';
        err.stderr = entry.error;
        reject(err);
        return;
      }
      resolve({ stdout: entry.result?.stdout ?? '', stderr: entry.result?.stderr ?? '' });
    });
  };
  return { exec: execImpl };
});

// -----------------------------------------------------------------------------
// Mock PRLinkService (best-effort call after create)
// -----------------------------------------------------------------------------
const parsePRUrlMock = vi.fn();
const fetchPRContextMock = vi.fn();
const createPRLinkMock = vi.fn();

vi.mock('../../../../../src/main/services/github/prLinkService', () => ({
  getPRLinkService: () => ({
    parsePRUrl: parsePRUrlMock,
    fetchPRContext: fetchPRContextMock,
    createPRLink: createPRLinkMock,
  }),
}));

import { githubPrModule } from '../../../../../src/main/tools/migrated/network/githubPr';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/repo',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await githubPrModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execResponses.length = 0;
  parsePRUrlMock.mockReset();
  fetchPRContextMock.mockReset();
  createPRLinkMock.mockReset();
  parsePRUrlMock.mockReturnValue(null);
  // gh installed by default
  execResponses.push({ match: 'gh --version', result: { stdout: 'gh version 2.0.0\n', stderr: '' } });
});

describe('githubPrModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(githubPrModule.schema.name).toBe('github_pr');
      expect(githubPrModule.schema.category).toBe('network');
      expect(githubPrModule.schema.permissionLevel).toBe('network');
      expect(githubPrModule.schema.readOnly).toBe(false);
      expect(githubPrModule.schema.allowInPlanMode).toBe(false);
      expect(githubPrModule.schema.inputSchema.required).toEqual(['action']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unknown action', async () => {
      const result = await run({ action: 'wipe' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'list' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ action: 'list' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('view requires pr param', async () => {
      const result = await run({ action: 'view' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('comment requires pr param', async () => {
      const result = await run({ action: 'comment', body: 'hi' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('comment requires body param', async () => {
      const result = await run({ action: 'comment', pr: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('review requires pr param', async () => {
      const result = await run({ action: 'review' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('merge requires pr param', async () => {
      const result = await run({ action: 'merge' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns INVALID_ARGS when gh CLI missing', async () => {
      // Replace the default gh --version success with an error
      execResponses.length = 0;
      execResponses.push({ match: 'gh --version', error: 'command not found: gh' });
      const result = await run({ action: 'list' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('gh CLI 未安装');
      }
    });
  });

  describe('create action', () => {
    it('creates PR happy path', async () => {
      execResponses.push({ match: 'git branch --show-current', result: { stdout: 'feature/x\n', stderr: '' } });
      execResponses.push({ match: 'git status --porcelain', result: { stdout: '', stderr: '' } });
      execResponses.push({ match: 'rev-parse --abbrev-ref', result: { stdout: 'origin/feature/x\n', stderr: '' } });
      execResponses.push({ match: 'rev-parse --verify main', result: { stdout: 'abc\n', stderr: '' } });
      execResponses.push({ match: 'git log main..HEAD', result: { stdout: 'abc1234 feat: add login\n', stderr: '' } });
      execResponses.push({
        match: 'gh pr create',
        result: { stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' },
      });

      const result = await run({ action: 'create', title: 'My PR' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('https://github.com/owner/repo/pull/42');
        expect(result.output).toContain('My PR');
      }
    });

    it('blocks creation from main branch', async () => {
      execResponses.push({ match: 'git branch --show-current', result: { stdout: 'main\n', stderr: '' } });
      const result = await run({ action: 'create' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('blocks creation with uncommitted changes', async () => {
      execResponses.push({ match: 'git branch --show-current', result: { stdout: 'feature/x\n', stderr: '' } });
      execResponses.push({ match: 'git status --porcelain', result: { stdout: ' M file.ts\n', stderr: '' } });
      const result = await run({ action: 'create' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('view action', () => {
    it('parses pr view JSON', async () => {
      execResponses.push({
        match: 'gh pr view',
        result: {
          stdout: JSON.stringify({
            number: 42,
            title: 'Add login',
            body: 'Body text',
            headRefName: 'feature/x',
            baseRefName: 'main',
            state: 'OPEN',
            changedFiles: 3,
            additions: 10,
            deletions: 2,
            labels: [{ name: 'enhancement' }],
            url: 'https://github.com/owner/repo/pull/42',
            author: { login: 'alice' },
            reviewDecision: 'APPROVED',
            mergeable: 'MERGEABLE',
            comments: [{ author: { login: 'bob' }, body: 'LGTM' }],
          }),
          stderr: '',
        },
      });

      const result = await run({ action: 'view', pr: 42 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PR #42');
        expect(result.output).toContain('Add login');
        expect(result.output).toContain('alice');
        expect(result.output).toContain('feature/x');
      }
    });
  });

  describe('list action', () => {
    it('lists PRs', async () => {
      execResponses.push({
        match: 'gh pr list',
        result: {
          stdout: JSON.stringify([
            {
              number: 1,
              title: 'First',
              state: 'OPEN',
              headRefName: 'a',
              author: { login: 'alice' },
              labels: [],
              url: 'u1',
              updatedAt: '2025-01-01',
            },
            {
              number: 2,
              title: 'Second',
              state: 'OPEN',
              headRefName: 'b',
              author: { login: 'bob' },
              labels: [{ name: 'bug' }],
              url: 'u2',
              updatedAt: '2025-01-02',
            },
          ]),
          stderr: '',
        },
      });

      const result = await run({ action: 'list' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('#1');
        expect(result.output).toContain('First');
        expect(result.output).toContain('#2');
        expect(result.output).toContain('Second');
      }
    });

    it('handles empty list', async () => {
      execResponses.push({ match: 'gh pr list', result: { stdout: '[]', stderr: '' } });
      const result = await run({ action: 'list' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('没有找到');
    });
  });

  describe('comment action', () => {
    it('posts comment', async () => {
      execResponses.push({ match: 'gh pr comment', result: { stdout: '', stderr: '' } });
      const result = await run({ action: 'comment', pr: 42, body: 'LGTM' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('PR #42');
    });
  });

  describe('review action', () => {
    it('submits approve review', async () => {
      execResponses.push({ match: 'gh pr review', result: { stdout: '', stderr: '' } });
      const result = await run({ action: 'review', pr: 42, event: 'approve', body: 'OK' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('approve');
    });
  });

  describe('merge action', () => {
    it('merges with squash', async () => {
      execResponses.push({ match: 'gh pr merge', result: { stdout: 'merged\n', stderr: '' } });
      const result = await run({ action: 'merge', pr: 42, method: 'squash', delete_branch: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PR #42');
        expect(result.output).toContain('squash');
      }
    });

    it('calls canUseTool twice (plain gate + dangerous gate) with correct reason prefix', async () => {
      execResponses.push({ match: 'gh pr merge', result: { stdout: 'merged\n', stderr: '' } });
      const calls: Array<{ reason?: string }> = [];
      const captureGate: CanUseToolFn = async (_name, _input, reason) => {
        calls.push({ reason });
        return { allow: true };
      };
      const result = await run(
        { action: 'merge', pr: 42, method: 'merge' },
        makeCtx(),
        captureGate,
      );
      expect(result.ok).toBe(true);
      expect(calls.length).toBe(2);
      // 第一次是顶层通用闸门（reason 为空或未指定）
      expect(calls[0].reason).toBeUndefined();
      // 第二次是 merge 专用危险闸门，带 dangerous: 前缀让 shadowAdapter 升级成 dangerous_command
      expect(calls[1].reason).toMatch(/^dangerous:merge PR #42/);
    });

    it('returns PERMISSION_DENIED when dangerous gate rejects', async () => {
      execResponses.push({ match: 'gh pr merge', result: { stdout: 'merged\n', stderr: '' } });
      let callCount = 0;
      const denyDangerous: CanUseToolFn = async (_name, _input, reason) => {
        callCount += 1;
        if (reason && reason.startsWith('dangerous:')) {
          return { allow: false, reason: 'user declined merge' };
        }
        return { allow: true };
      };
      const result = await run(
        { action: 'merge', pr: 42 },
        makeCtx(),
        denyDangerous,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PERMISSION_DENIED');
        expect(result.error).toContain('user declined merge');
      }
      expect(callCount).toBe(2);
    });
  });

  describe('exec error wrapping', () => {
    it('wraps exec errors as NETWORK_ERROR', async () => {
      execResponses.push({ match: 'gh pr list', error: 'gh failed: rate limit' });
      const result = await run({ action: 'list' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NETWORK_ERROR');
        expect(result.error).toContain('gh failed');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execResponses.push({ match: 'gh pr list', result: { stdout: '[]', stderr: '' } });
      const onProgress = vi.fn();
      await run({ action: 'list' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
