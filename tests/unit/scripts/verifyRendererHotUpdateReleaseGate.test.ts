import { describe, expect, it } from 'vitest';
import { GithubWorkflowRunVerificationError } from '../../../scripts/verify-github-workflow-run.mjs';
import {
  parseRendererHotUpdateReleaseGateArgs,
  RendererHotUpdateReleaseGateError,
  verifyRendererHotUpdateReleaseGate,
} from '../../../scripts/verify-renderer-hot-update-release-gate.mjs';

describe('verifyRendererHotUpdateReleaseGate', () => {
  it('checks the paired renderer workflow before production hot-update artifacts', async () => {
    const calls: string[] = [];

    const summary = await verifyRendererHotUpdateReleaseGate({
      ...parseRendererHotUpdateReleaseGateArgs([
        '--workflow',
        'renderer-bundle.yml',
        '--repo',
        'owner/repo',
        '--head-sha',
        'abc123',
        '--expected-version',
        '0.16.93',
        '--retry-attempts',
        '3',
        '--retry-delay-ms',
        '250',
      ], {}),
      verifyGithubWorkflowRunImpl: async (options: unknown) => {
        calls.push('workflow');
        return { workflow: 'renderer-bundle.yml', run: { id: 42 }, options };
      },
      verifyRendererHotUpdateProductionWithRetryImpl: async (options: unknown) => {
        calls.push('production');
        return { rendererBundle: { version: '0.16.93' }, options };
      },
    });

    expect(calls).toEqual(['workflow', 'production']);
    expect(summary.workflowRun).toMatchObject({
      skipped: false,
      workflow: 'renderer-bundle.yml',
      run: { id: 42 },
    });
    expect(summary.production).toMatchObject({
      rendererBundle: { version: '0.16.93' },
    });
  });

  it('can skip the workflow run check for local production-only diagnostics', async () => {
    let workflowCalls = 0;

    const summary = await verifyRendererHotUpdateReleaseGate({
      ...parseRendererHotUpdateReleaseGateArgs([
        '--skip-workflow-run',
        '--expected-version',
        '0.16.93',
      ], {}),
      verifyGithubWorkflowRunImpl: async () => {
        workflowCalls += 1;
        return {};
      },
      verifyRendererHotUpdateProductionWithRetryImpl: async () => ({
        rendererBundle: { version: '0.16.93' },
      }),
    });

    expect(workflowCalls).toBe(0);
    expect(summary.workflowRun).toEqual({ skipped: true });
  });

  it('defaults expected version from the GitHub tag ref', () => {
    const args = parseRendererHotUpdateReleaseGateArgs([
      '--workflow',
      'renderer-bundle.yml',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.16.94',
      GITHUB_TOKEN: 'github-token',
    });

    expect(args).toMatchObject({
      workflowRun: {
        repo: 'owner/repo',
        workflow: 'renderer-bundle.yml',
        headSha: 'abc123',
        event: 'push',
        branch: 'v0.16.94',
        token: 'github-token',
      },
      production: {
        expectedVersion: '0.16.94',
        expectedReleaseChannel: 'latest',
      },
    });
  });

  it('does not default workflow branch from a non-tag GitHub ref', () => {
    const args = parseRendererHotUpdateReleaseGateArgs([
      '--workflow',
      'renderer-bundle.yml',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
    });

    expect(args.workflowRun.branch).toBeUndefined();
  });

  it('does not default expected version from a non-tag GitHub ref', () => {
    const args = parseRendererHotUpdateReleaseGateArgs([
      '--workflow',
      'renderer-bundle.yml',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
    });

    expect(args.production.expectedVersion).toBeUndefined();
  });

  it('does not default expected version from a branch that looks like a version tag', () => {
    const args = parseRendererHotUpdateReleaseGateArgs([
      '--workflow',
      'renderer-bundle.yml',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'v0.16.94',
    });

    expect(args.production.expectedVersion).toBeUndefined();
  });

  it('passes production verifier options through while stripping workflow-only options', () => {
    const args = parseRendererHotUpdateReleaseGateArgs([
      '--workflow',
      'renderer-bundle.yml',
      '--github-token',
      'github-token',
      '--workflow-branch',
      'main',
      '--workflow-timeout-ms',
      '1234',
      '--workflow-poll-ms',
      '50',
      '--workflow-per-page',
      '50',
      '--expected-version',
      '0.16.94',
      '--expected-release-channel',
      'latest',
      '--retry-attempts',
      '12',
      '--retry-delay-ms',
      '30000',
      '--token',
      'control-plane-token',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
    });

    expect(args.workflowRun).toMatchObject({
      token: 'github-token',
      branch: 'main',
      timeoutMs: 1234,
      pollMs: 50,
      perPage: 50,
    });
    expect(args.production).toMatchObject({
      controlPlaneToken: 'control-plane-token',
      expectedVersion: '0.16.94',
      expectedReleaseChannel: 'latest',
      retryAttempts: 12,
      retryDelayMs: 30000,
    });
  });

  it('passes app-update-derived expected version mode through to production verifier', () => {
    const args = parseRendererHotUpdateReleaseGateArgs([
      '--skip-workflow-run',
      '--expected-version-from-app-update',
      '--app-update-url',
      'https://control-plane.example/api/update?action=check&version=0.0.0&platform=darwin&channel=stable',
    ], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
    });

    expect(args.production).toMatchObject({
      expectedVersion: undefined,
      expectedVersionFromAppUpdate: true,
      appUpdateUrl: 'https://control-plane.example/api/update?action=check&version=0.0.0&platform=darwin&channel=stable',
    });
  });

  it('stops before production verification when the paired workflow fails', async () => {
    let productionCalls = 0;

    await expect(verifyRendererHotUpdateReleaseGate({
      ...parseRendererHotUpdateReleaseGateArgs([
        '--workflow',
        'renderer-bundle.yml',
        '--repo',
        'owner/repo',
        '--head-sha',
        'abc123',
        '--expected-version',
        '0.16.94',
      ], {}),
      verifyGithubWorkflowRunImpl: async () => {
        throw new GithubWorkflowRunVerificationError('workflow failed', {
          code: 'unexpected_conclusion',
          details: { run: { id: 42, conclusion: 'failure' } },
        });
      },
      verifyRendererHotUpdateProductionWithRetryImpl: async () => {
        productionCalls += 1;
        return {};
      },
    })).rejects.toMatchObject({
      code: 'unexpected_conclusion',
      details: {
        run: { id: 42, conclusion: 'failure' },
      },
    });
    expect(productionCalls).toBe(0);
  });

  it('validates workflow timing options', () => {
    expect(() => parseRendererHotUpdateReleaseGateArgs([
      '--workflow',
      'renderer-bundle.yml',
      '--workflow-timeout-ms',
      '-1',
    ], {})).toThrowError(RendererHotUpdateReleaseGateError);
  });
});
