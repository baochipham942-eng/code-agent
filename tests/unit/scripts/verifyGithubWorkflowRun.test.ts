import { describe, expect, it } from 'vitest';
import {
  GithubWorkflowRunVerificationError,
  parseGithubWorkflowRunArgs,
  verifyGithubWorkflowRun,
} from '../../../scripts/verify-github-workflow-run.mjs';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('verifyGithubWorkflowRun', () => {
  it('finds a completed successful workflow run for the same head sha', async () => {
    const fetchedUrls: string[] = [];
    const summary = await verifyGithubWorkflowRun({
      repo: 'owner/repo',
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
      event: 'push',
      token: 'token',
      timeoutMs: 1,
      pollMs: 0,
      fetchImpl: async (url: URL | RequestInfo) => {
        fetchedUrls.push(String(url));
        return jsonResponse({
          workflow_runs: [
            {
              id: 42,
              name: 'Publish Renderer Bundle (hot update)',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
              head_sha: 'abc123',
              head_branch: 'main',
              html_url: 'https://github.example/runs/42',
              created_at: '2026-06-06T00:00:00Z',
              updated_at: '2026-06-06T00:01:00Z',
            },
          ],
        });
      },
    });

    expect(fetchedUrls[0]).toContain('/repos/owner/repo/actions/workflows/renderer-bundle.yml/runs');
    expect(fetchedUrls[0]).toContain('head_sha=abc123');
    expect(fetchedUrls[0]).toContain('event=push');
    expect(summary).toMatchObject({
      workflow: 'renderer-bundle.yml',
      repo: 'owner/repo',
      headSha: 'abc123',
      run: {
        id: 42,
        conclusion: 'success',
        headSha: 'abc123',
      },
    });
  });

  it('waits for an in-progress run to complete', async () => {
    let calls = 0;

    const summary = await verifyGithubWorkflowRun({
      repo: 'owner/repo',
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
      timeoutMs: 10,
      pollMs: 0,
      now: () => calls,
      sleepImpl: async () => {
        calls += 1;
      },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({
          workflow_runs: [
            {
              id: 42,
              event: 'push',
              status: calls < 2 ? 'in_progress' : 'completed',
              conclusion: calls < 2 ? null : 'success',
              head_sha: 'abc123',
            },
          ],
        });
      },
    });

    expect(summary.attempts).toBeGreaterThan(1);
    expect(summary.run.conclusion).toBe('success');
  });

  it('fails fast when the matching workflow run completed unsuccessfully', async () => {
    await expect(verifyGithubWorkflowRun({
      repo: 'owner/repo',
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
      timeoutMs: 1,
      pollMs: 0,
      fetchImpl: async () => jsonResponse({
        workflow_runs: [
          {
            id: 42,
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            head_sha: 'abc123',
          },
        ],
      }),
    })).rejects.toMatchObject({
      code: 'unexpected_conclusion',
    });
  });

  it('uses the newest matching run when GitHub returns multiple runs for the same head sha', async () => {
    const summary = await verifyGithubWorkflowRun({
      repo: 'owner/repo',
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
      timeoutMs: 1,
      pollMs: 0,
      fetchImpl: async () => jsonResponse({
        workflow_runs: [
          {
            id: 41,
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            head_sha: 'abc123',
            updated_at: '2026-06-06T00:01:00Z',
          },
          {
            id: 42,
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            updated_at: '2026-06-06T00:02:00Z',
          },
        ],
      }),
    });

    expect(summary.run).toMatchObject({
      id: 42,
      conclusion: 'success',
    });
  });

  it('does not allow an older successful run to hide the newest failure', async () => {
    await expect(verifyGithubWorkflowRun({
      repo: 'owner/repo',
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
      timeoutMs: 1,
      pollMs: 0,
      fetchImpl: async () => jsonResponse({
        workflow_runs: [
          {
            id: 41,
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            updated_at: '2026-06-06T00:01:00Z',
          },
          {
            id: 42,
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            head_sha: 'abc123',
            updated_at: '2026-06-06T00:02:00Z',
          },
        ],
      }),
    })).rejects.toMatchObject({
      code: 'unexpected_conclusion',
      details: {
        run: expect.objectContaining({
          id: 42,
          conclusion: 'failure',
        }),
      },
    });
  });

  it('times out when no matching workflow run appears', async () => {
    await expect(verifyGithubWorkflowRun({
      repo: 'owner/repo',
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
      timeoutMs: 0,
      pollMs: 0,
      fetchImpl: async () => jsonResponse({
        workflow_runs: [
          {
            id: 99,
            name: 'Publish Renderer Bundle (hot update)',
            event: 'workflow_dispatch',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'different-sha',
            head_branch: 'main',
          },
        ],
      }),
    })).rejects.toMatchObject({
      code: 'timeout',
      details: {
        latestCandidates: [
          expect.objectContaining({
            id: 99,
            event: 'workflow_dispatch',
            headSha: 'different-sha',
          }),
        ],
      },
    });
  });

  it('parses GitHub Actions defaults from env', () => {
    expect(parseGithubWorkflowRunArgs([
      '--workflow',
      'renderer-bundle.yml',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_TOKEN: 'token',
    })).toMatchObject({
      workflow: 'renderer-bundle.yml',
      repo: 'owner/repo',
      headSha: 'abc123',
      event: 'push',
      expectedConclusion: 'success',
      token: 'token',
    });
  });

  it('validates required arguments', async () => {
    await expect(verifyGithubWorkflowRun({
      workflow: 'renderer-bundle.yml',
      headSha: 'abc123',
    })).rejects.toBeInstanceOf(GithubWorkflowRunVerificationError);
    expect(() => parseGithubWorkflowRunArgs([
      '--workflow',
      'renderer-bundle.yml',
      '--timeout-ms',
      '-1',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
    })).toThrowError(GithubWorkflowRunVerificationError);
  });
});
