import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATHS = [
  'src',
  'src-tauri',
  'resources',
  'public',
  'scripts',
  'tests',
  'package.json',
  'docs/architecture',
  'docs/plans',
] as const;

export interface SurfaceAcceptanceSourceFingerprintV1 {
  version: 1;
  algorithm: 'sha256';
  sha256: string;
  head: string;
  dirty: boolean;
  dirtyPaths: string[];
  scopes: string[];
}

export interface SurfaceAcceptanceCampaignV1 {
  id: string;
  startedAt: string;
}

export interface SurfaceAcceptanceCampaignProofFieldsV1 {
  campaign?: SurfaceAcceptanceCampaignV1;
}

const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseSurfaceAcceptanceCampaign(input: {
  id?: string;
  startedAt?: string;
}): SurfaceAcceptanceCampaignV1 | undefined {
  const hasId = input.id !== undefined;
  const hasStartedAt = input.startedAt !== undefined;
  if (!hasId && !hasStartedAt) return undefined;
  if (!hasId || !hasStartedAt) {
    throw new Error(
      'Surface acceptance campaign requires both id and startedAt',
    );
  }
  const id = input.id as string;
  const startedAt = input.startedAt as string;
  if (id !== id.trim() || !CAMPAIGN_ID_PATTERN.test(id)) {
    throw new Error(
      'Surface acceptance campaign id must be 1-128 safe ASCII characters',
    );
  }
  const timestampMs = Date.parse(startedAt);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== startedAt) {
    throw new Error(
      'Surface acceptance campaign startedAt must be a canonical UTC ISO timestamp',
    );
  }
  return { id, startedAt };
}

export function surfaceAcceptanceCampaignFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SurfaceAcceptanceCampaignV1 | undefined {
  return parseSurfaceAcceptanceCampaign({
    id: env.SURFACE_ACCEPTANCE_CAMPAIGN_ID,
    startedAt: env.SURFACE_ACCEPTANCE_CAMPAIGN_STARTED_AT,
  });
}

export function surfaceAcceptanceCampaignProofFields(
  env: NodeJS.ProcessEnv = process.env,
): SurfaceAcceptanceCampaignProofFieldsV1 {
  const campaign = surfaceAcceptanceCampaignFromEnv(env);
  return campaign ? { campaign } : {};
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitBytes(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, encoding: 'buffer' });
}

function nulSeparated(value: Buffer): string[] {
  return value
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Fingerprints the checked-out implementation behind Surface acceptance proof.
 * Generated proof and screenshot directories are intentionally outside these
 * scopes, so writing a proof cannot change the fingerprint it records.
 */
export function surfaceAcceptanceSourceFingerprint(
  cwd = process.cwd(),
): SurfaceAcceptanceSourceFingerprintV1 {
  const head = gitText(cwd, ['rev-parse', 'HEAD']).trim();
  const trackedDiff = gitBytes(cwd, ['diff', '--binary', 'HEAD', '--', ...SOURCE_PATHS]);
  const trackedPaths = gitText(cwd, [
    'diff',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    'HEAD',
    '--',
    ...SOURCE_PATHS,
  ]).split('\n').filter(Boolean);
  const untrackedPaths = nulSeparated(gitBytes(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...SOURCE_PATHS,
  ]));
  const dirtyPaths = Array.from(new Set([...trackedPaths, ...untrackedPaths]))
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  hash.update('neo-surface-acceptance-source-v1\0');
  hash.update(head);
  hash.update('\0tracked-diff\0');
  hash.update(trackedDiff);
  hash.update('\0untracked\0');
  for (const path of untrackedPaths) {
    const absolutePath = resolve(cwd, path);
    const stat = lstatSync(absolutePath);
    hash.update(path);
    hash.update('\0');
    hash.update(stat.isSymbolicLink() ? readlinkSync(absolutePath) : readFileSync(absolutePath));
    hash.update('\0');
  }
  return {
    version: 1,
    algorithm: 'sha256',
    sha256: hash.digest('hex'),
    head,
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
    scopes: [...SOURCE_PATHS],
  };
}
