import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- release tooling is intentionally implemented as dependency-free ESM.
import { buildClosureEvidenceEvent, buildDeliveryClosure, buildTaskClosure, classifyAcceptanceScript, formatClosureEvidenceMarker } from '../../scripts/lib/closure-evidence.mjs';

const tempDirs: string[] = [];

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-closure-test-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/example.mjs'), 'export const value = 1;\n');
  return root;
}

function diffEvidence(changedPaths = ['scripts/example.mjs']) {
  return {
    baseRef: 'origin/main',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    changedPaths,
    diffSha256: 'c'.repeat(64),
  };
}

function taskSpec(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    evidenceProfile: 'better-harness-closure-v1',
    baseRef: 'origin/main',
    checks: [{ id: 'focused', packageScript: 'test:closure', reason: 'focused closure regression' }],
    acceptance: [{
      id: 'acceptance',
      packageScript: 'acceptance:closure',
      reason: 'closure CLI acceptance',
      readbacks: [{ path: 'scripts/example.mjs', nonEmpty: true, contains: ['export const value'] }],
    }],
    scopeMappings: [{
      pathPrefixes: ['scripts/'],
      checkIds: ['focused'],
      acceptanceIds: ['acceptance'],
    }],
    ...overrides,
  };
}

const packageScripts = {
  'test:closure': 'vitest run tests/scripts/closureEvidence.test.ts',
  'acceptance:closure': 'npm run test:closure',
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('task closure evidence', () => {
  it('binds the final diff to focused checks, exit codes, acceptance, and readback fingerprints', async () => {
    const root = tempRepo();
    const executed: string[] = [];
    const report = await buildTaskClosure(taskSpec(), {
      repoRoot: root,
      packageScripts,
      diffEvidence: diffEvidence(),
      generatedAt: '2026-08-01T00:00:00.000Z',
      runPackageScript: async (packageScript: string) => {
        executed.push(packageScript);
        return { exitCode: 0, stdout: `${packageScript} passed`, stderr: '' };
      },
    });

    expect(report.status).toBe('VERIFIED');
    expect(executed).toEqual(['test:closure', 'acceptance:closure']);
    expect(report.repository).toMatchObject({
      changedPaths: ['scripts/example.mjs'],
      diffSha256: 'c'.repeat(64),
    });
    expect(report.checks[0]).toMatchObject({ exitCode: 0, status: 'PASSED' });
    expect(report.acceptance[0]).toMatchObject({
      exitCode: 0,
      source: 'acceptance',
      status: 'VERIFIED',
    });
    expect(report.acceptance[0].readbacks[0]).toMatchObject({
      path: 'scripts/example.mjs',
      status: 'VERIFIED',
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('fails closed before running commands when any final diff path is unmapped', async () => {
    const root = tempRepo();
    const report = await buildTaskClosure(taskSpec(), {
      repoRoot: root,
      packageScripts,
      diffEvidence: diffEvidence(['src/unmapped.ts']),
      runPackageScript: async () => {
        throw new Error('must not run');
      },
    });

    expect(report.status).toBe('BLOCKED');
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'unmapped_diff_path', path: 'src/unmapped.ts' }));
    expect(report.checks[0].status).toBe('NOT_RUN');
    expect(report.acceptance[0].status).toBe('NOT_RUN');
  });

  it('fails closed when acceptance readback is missing', async () => {
    const root = tempRepo();
    const spec = taskSpec({
      acceptance: [{
        id: 'acceptance',
        packageScript: 'acceptance:closure',
        reason: 'closure CLI acceptance',
        readbacks: [{ path: 'missing.json', nonEmpty: true }],
      }],
    });
    const report = await buildTaskClosure(spec, {
      repoRoot: root,
      packageScripts,
      diffEvidence: diffEvidence(),
      runPackageScript: async () => ({ exitCode: 0, stdout: 'passed', stderr: '' }),
    });

    expect(report.status).toBe('BLOCKED');
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'acceptance_readback_failed' }));
    expect(report.acceptance[0].readbacks[0]).toMatchObject({ status: 'FAILED', failure: 'missing_file' });
  });

  it('records a focused check failure and does not run acceptance', async () => {
    const root = tempRepo();
    const executed: string[] = [];
    const report = await buildTaskClosure(taskSpec(), {
      repoRoot: root,
      packageScripts,
      diffEvidence: diffEvidence(),
      runPackageScript: async (packageScript: string) => {
        executed.push(packageScript);
        return { exitCode: 7, stdout: '', stderr: 'focused failure' };
      },
    });

    expect(report.status).toBe('BLOCKED');
    expect(executed).toEqual(['test:closure']);
    expect(report.checks[0]).toMatchObject({ status: 'FAILED', exitCode: 7 });
    expect(report.acceptance[0]).toMatchObject({ status: 'NOT_RUN', exitCode: null });
  });

  it('fails closed when verification commands change the final diff snapshot', async () => {
    const root = tempRepo();
    const report = await buildTaskClosure(taskSpec(), {
      repoRoot: root,
      packageScripts,
      diffEvidence: diffEvidence(),
      postVerificationDiffEvidence: { ...diffEvidence(), diffSha256: 'f'.repeat(64) },
      runPackageScript: async () => ({ exitCode: 0, stdout: 'passed', stderr: '' }),
    });

    expect(report.status).toBe('BLOCKED');
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'task_closure_snapshot_drift',
      checkedDiffSha256: 'c'.repeat(64),
      finalDiffSha256: 'f'.repeat(64),
    }));
  });

  it('accepts only existing acceptance, release, smoke, or gates:local entrypoints for acceptance evidence', () => {
    expect(classifyAcceptanceScript('acceptance:closure')).toBe('acceptance');
    expect(classifyAcceptanceScript('release:post-publish')).toBe('release');
    expect(classifyAcceptanceScript('smoke:cli')).toBe('smoke');
    expect(classifyAcceptanceScript('gates:local')).toBe('gate');
    expect(classifyAcceptanceScript('test:closure')).toBeNull();
  });
});

describe('delivery closure evidence', () => {
  function verifiedTaskClosure() {
    return {
      schemaVersion: 1,
      kind: 'better-harness.task-closure',
      taskId: 'task-1',
      evidenceProfile: 'better-harness-closure-v1',
      comparisonKey: 'd'.repeat(64),
      status: 'VERIFIED',
      repository: diffEvidence(),
      acceptance: [{
        id: 'acceptance',
        packageScript: 'acceptance:closure',
        source: 'acceptance',
        exitCode: 0,
        status: 'VERIFIED',
        readbacks: [{ path: 'scripts/example.mjs', status: 'VERIFIED', sha256: 'e'.repeat(64) }],
      }],
    };
  }

  function deliverySpec(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      deliveryId: 'delivery-1',
      evidenceProfile: 'better-harness-closure-v1',
      deliverable: { commitRef: 'HEAD', artifactPaths: ['scripts/example.mjs'] },
      approvalBoundary: {
        currentScope: ['local edits', 'local verification'],
        requiresApproval: ['commit', 'push', 'merge'],
        prohibitedActions: ['manual merge', 'force push'],
      },
      recoveryActions: [],
      handoff: { summary: 'context only' },
      ...overrides,
    };
  }

  it('derives VERIFIED only from current task evidence, fingerprints, acceptance, and approval boundaries', () => {
    const root = tempRepo();
    const report = buildDeliveryClosure(deliverySpec(), {
      repoRoot: root,
      taskClosure: verifiedTaskClosure(),
      generatedAt: '2026-08-01T00:00:00.000Z',
      resolveCommit: () => 'b'.repeat(40),
      collectDiffEvidence: () => diffEvidence(),
    });

    expect(report.status).toBe('VERIFIED');
    expect(report.deliverable.commit.sha).toBe('b'.repeat(40));
    expect(report.deliverable.artifacts[0]).toMatchObject({ status: 'FINGERPRINTED', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(report.acceptanceResults[0]).toMatchObject({ status: 'VERIFIED', exitCode: 0 });
    expect(report.handoff).toMatchObject({ completionEvidence: false });
  });

  it('keeps a handoff-only delivery BLOCKED', () => {
    const root = tempRepo();
    const report = buildDeliveryClosure(deliverySpec(), {
      repoRoot: root,
      resolveCommit: () => 'b'.repeat(40),
    });

    expect(report.status).toBe('BLOCKED');
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'task_closure_missing' }));
    expect(report.handoff.completionEvidence).toBe(false);
  });

  it('derives RECOVERY_REQUIRED when the final repository fingerprint drifts', () => {
    const root = tempRepo();
    const report = buildDeliveryClosure(deliverySpec(), {
      repoRoot: root,
      taskClosure: verifiedTaskClosure(),
      resolveCommit: () => 'b'.repeat(40),
      collectDiffEvidence: () => ({ ...diffEvidence(), diffSha256: 'f'.repeat(64) }),
    });

    expect(report.status).toBe('RECOVERY_REQUIRED');
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'task_closure_snapshot_drift' }));
    expect(report.recoveryActions).toContain('rerun task closure against the final repository state');
  });

  it('preserves declared failure and recovery actions without inventing a verified outcome', () => {
    const root = tempRepo();
    const report = buildDeliveryClosure(deliverySpec({
      failureReason: 'release smoke failed after upload',
      recoveryActions: ['restore the last verified artifact and rerun release smoke'],
    }), {
      repoRoot: root,
      taskClosure: verifiedTaskClosure(),
      resolveCommit: () => 'b'.repeat(40),
      collectDiffEvidence: () => diffEvidence(),
    });

    expect(report.status).toBe('RECOVERY_REQUIRED');
    expect(report.failureReason).toBe('release smoke failed after upload');
    expect(report.recoveryActions).toEqual(['restore the last verified artifact and rerun release smoke']);
  });

  it('keeps comparison keys stable across run timestamps', () => {
    const root = tempRepo();
    const options = {
      repoRoot: root,
      taskClosure: verifiedTaskClosure(),
      resolveCommit: () => 'b'.repeat(40),
      collectDiffEvidence: () => diffEvidence(),
    };
    const first = buildDeliveryClosure(deliverySpec(), { ...options, generatedAt: '2026-08-01T00:00:00.000Z' });
    const second = buildDeliveryClosure(deliverySpec(), { ...options, generatedAt: '2026-08-02T00:00:00.000Z' });

    expect(first.comparisonKey).toBe(second.comparisonKey);
    expect(first.generatedAt).not.toBe(second.generatedAt);
  });
});

describe('Better Harness evidence marker', () => {
  it('projects only the bounded task facts needed for fail-closed consumption', async () => {
    const root = tempRepo();
    const report = await buildTaskClosure(taskSpec(), {
      repoRoot: root,
      packageScripts,
      diffEvidence: diffEvidence(),
      runPackageScript: async () => ({ exitCode: 0, stdout: 'passed', stderr: '' }),
    });
    const digest = 'f'.repeat(64);
    const evidence = buildClosureEvidenceEvent(report, digest);

    expect(evidence).toMatchObject({
      kind: 'better-harness.task-closure',
      status: 'VERIFIED',
      reportSha256: digest,
      repository: { diffSha256: 'c'.repeat(64), changedPaths: ['scripts/example.mjs'] },
      checks: [{ id: 'focused', exitCode: 0, status: 'PASSED' }],
      acceptance: [{ id: 'acceptance', exitCode: 0, status: 'VERIFIED', readbacksVerified: true }],
    });
    expect(formatClosureEvidenceMarker(report, digest)).toMatch(/^BETTER_HARNESS_EVIDENCE_V1 \{/);
    expect(JSON.stringify(evidence)).not.toContain('stdoutTail');
  });

  it('keeps handoff and recovery metadata outcome-only in delivery evidence', () => {
    const root = tempRepo();
    const taskClosure = {
      schemaVersion: 1,
      kind: 'better-harness.task-closure',
      taskId: 'task-1',
      evidenceProfile: 'better-harness-closure-v1',
      comparisonKey: 'd'.repeat(64),
      status: 'VERIFIED',
      repository: diffEvidence(),
      acceptance: [{
        id: 'acceptance',
        packageScript: 'acceptance:closure',
        source: 'acceptance',
        exitCode: 0,
        status: 'VERIFIED',
        readbacks: [{ path: 'scripts/example.mjs', status: 'VERIFIED', sha256: 'e'.repeat(64) }],
      }],
    };
    const report = buildDeliveryClosure({
      schemaVersion: 1,
      deliveryId: 'delivery-1',
      evidenceProfile: 'better-harness-closure-v1',
      deliverable: { commitRef: 'HEAD', artifactPaths: ['scripts/example.mjs'] },
      approvalBoundary: {
        currentScope: ['local verification'],
        requiresApproval: ['push'],
        prohibitedActions: ['force push'],
      },
      recoveryActions: [],
      handoff: { summary: 'context only' },
    }, {
      repoRoot: root,
      taskClosure,
      resolveCommit: () => 'b'.repeat(40),
      collectDiffEvidence: () => diffEvidence(),
    });
    const evidence = buildClosureEvidenceEvent(report, 'f'.repeat(64));

    expect(evidence).toMatchObject({
      kind: 'better-harness.delivery-closure',
      status: 'VERIFIED',
      handoffCompletionEvidence: false,
      approvalBoundaryPresent: true,
      taskClosure: { status: 'VERIFIED', diffSha256: 'c'.repeat(64) },
      deliverable: { diffSha256: 'c'.repeat(64) },
    });
  });
});
