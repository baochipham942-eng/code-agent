import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSurfaceAcceptanceCampaign,
  surfaceAcceptanceCampaignFromEnv,
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
} from '../../../scripts/acceptance/surface-execution-proof.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('surface acceptance source proof', () => {
  it('strictly validates optional acceptance campaign environment metadata', () => {
    expect(surfaceAcceptanceCampaignFromEnv({})).toBeUndefined();
    expect(() => surfaceAcceptanceCampaignFromEnv({
      SURFACE_ACCEPTANCE_CAMPAIGN_ID: 'campaign-only',
    })).toThrow('requires both id and startedAt');
    expect(() => parseSurfaceAcceptanceCampaign({
      id: 'campaign with spaces',
      startedAt: '2026-07-21T00:00:00.000Z',
    })).toThrow('safe ASCII');
    expect(() => parseSurfaceAcceptanceCampaign({
      id: 'valid-campaign',
      startedAt: '2026-07-21T00:00:00Z',
    })).toThrow('canonical UTC ISO timestamp');

    const env = {
      SURFACE_ACCEPTANCE_CAMPAIGN_ID: 'surface-campaign-20260721',
      SURFACE_ACCEPTANCE_CAMPAIGN_STARTED_AT: '2026-07-21T00:00:00.000Z',
    };
    expect(surfaceAcceptanceCampaignProofFields(env)).toEqual({
      campaign: {
        id: env.SURFACE_ACCEPTANCE_CAMPAIGN_ID,
        startedAt: env.SURFACE_ACCEPTANCE_CAMPAIGN_STARTED_AT,
      },
    });
  });

  it('changes for scoped source edits while ignoring generated acceptance proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-source-proof-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'docs', 'acceptance'), { recursive: true });
      writeFileSync(join(root, 'src', 'runtime.ts'), 'export const revision = 1;\n');
      writeFileSync(join(root, 'docs', 'acceptance', 'proof.json'), '{"status":"old"}\n');
      git(root, ['init']);
      git(root, ['add', '.']);
      git(root, [
        '-c', 'user.name=Surface Acceptance',
        '-c', 'user.email=surface-acceptance@example.invalid',
        'commit', '-m', 'baseline',
      ]);

      const baseline = surfaceAcceptanceSourceFingerprint(root);
      expect(baseline).toMatchObject({
        version: 1,
        algorithm: 'sha256',
        dirty: false,
        dirtyPaths: [],
      });

      writeFileSync(join(root, 'docs', 'acceptance', 'proof.json'), '{"status":"current"}\n');
      expect(surfaceAcceptanceSourceFingerprint(root)).toEqual(baseline);

      writeFileSync(join(root, 'src', 'runtime.ts'), 'export const revision = 2;\n');
      const sourceChanged = surfaceAcceptanceSourceFingerprint(root);
      expect(sourceChanged.sha256).not.toBe(baseline.sha256);
      expect(sourceChanged.dirty).toBe(true);
      expect(sourceChanged.dirtyPaths).toEqual(['src/runtime.ts']);

      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'new-acceptance.ts'), 'export {};\n');
      const untrackedChanged = surfaceAcceptanceSourceFingerprint(root);
      expect(untrackedChanged.sha256).not.toBe(sourceChanged.sha256);
      expect(untrackedChanged.dirtyPaths).toEqual([
        'scripts/new-acceptance.ts',
        'src/runtime.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'scripts/acceptance/surface-execution-computer-smoke.ts',
    'scripts/acceptance/surface-execution-cross-surface-smoke.ts',
  ])('records the source fingerprint before every proof status path in %s', (path) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    const proofStart = source.indexOf('const proof: Record<string, unknown> = {');
    const fingerprint = source.indexOf(
      'sourceFingerprint: surfaceAcceptanceSourceFingerprint(),',
      proofStart,
    );
    const statusPaths = source.indexOf('try {', proofStart);
    expect(proofStart).toBeGreaterThanOrEqual(0);
    expect(fingerprint).toBeGreaterThan(proofStart);
    expect(statusPaths).toBeGreaterThan(fingerprint);
  });

  it.each([
    ['scripts/acceptance/surface-execution-managed-smoke.ts', 1],
    ['scripts/acceptance/surface-execution-relay-smoke.ts', 2],
    ['scripts/acceptance/surface-execution-workbuddy-smoke.ts', 1],
    ['scripts/acceptance/surface-execution-computer-smoke.ts', 1],
    ['scripts/acceptance/surface-execution-cross-surface-smoke.ts', 1],
    ['scripts/acceptance/surface-execution-conversation-smoke.ts', 2],
    ['scripts/acceptance/surface-execution-stop-benchmark.ts', 1],
    ['scripts/acceptance/surface-execution-controlled-complex-smoke.ts', 2],
  ] as const)('records campaign metadata on every persisted proof root in %s', (path, roots) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    expect(source).toContain('const campaignProof = surfaceAcceptanceCampaignProofFields();');
    expect(source.match(/\.\.\.campaignProof,/g)).toHaveLength(roots);
  });

  it('isolates the canonical Computer runtime and proves zero mutation on permission block', () => {
    const packageJson = JSON.parse(readFileSync(
      resolve(process.cwd(), 'package.json'),
      'utf8',
    )) as { scripts?: Record<string, string> };
    const command = packageJson.scripts?.['acceptance:surface-execution-computer'];
    expect(command).toContain('CODE_AGENT_DATA_DIR=/tmp/code-agent-surface-computer-$$');

    const source = readFileSync(resolve(
      process.cwd(),
      'scripts/acceptance/surface-execution-computer-smoke.ts',
    ), 'utf8');
    const permissionBlock = source.slice(
      source.indexOf('if (!permissionResult.success || !permissions.ready)'),
      source.indexOf("proof.stage = 'fixture'"),
    );
    expect(permissionBlock).toContain('computerMutationAttempted === 0');
    expect(permissionBlock).toContain('computerMutationForwarded === 0');
    expect(permissionBlock).toContain('assertions.computerMutationAttemptedZero = true');
    expect(permissionBlock).toContain('assertions.computerMutationForwardedZero = true');
  });

  it.each([
    {
      path: 'scripts/acceptance/surface-execution-computer-smoke.ts',
      writeNeedle: "writeJson(join(outputDir, 'proof.json'), proof);",
    },
    {
      path: 'scripts/acceptance/surface-execution-cross-surface-smoke.ts',
      writeNeedle: "writeFileSync(join(outputDir, 'proof.json')",
    },
  ])('checks every persisted proof state for canary leakage in $path', ({ path, writeNeedle }) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    const finalizer = source.lastIndexOf('} finally {');
    const redactionCheck = source.indexOf('withoutCanary(proof,', finalizer);
    const proofWrite = source.indexOf(writeNeedle, finalizer);
    expect(finalizer).toBeGreaterThanOrEqual(0);
    expect(redactionCheck).toBeGreaterThan(finalizer);
    expect(proofWrite).toBeGreaterThan(redactionCheck);
  });
});
