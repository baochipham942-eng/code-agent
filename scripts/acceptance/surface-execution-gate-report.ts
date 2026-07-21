import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
  requireStringOption,
} from './_helpers.ts';
import {
  artifactRecords,
  artifactRequirementKey,
  collectArtifactRequirements,
  evaluateSurfaceGateReport,
  SURFACE_GATE_PROOF_PATHS,
  type ArtifactFact,
  type ArtifactRequirement,
  type LoadedSurfaceProof,
  type SurfaceGateGitEvidence,
  type SurfaceGateProofId,
} from './surface-execution-gate-report-core.ts';
import {
  parseSurfaceAcceptanceCampaign,
  surfaceAcceptanceSourceFingerprint,
} from './surface-execution-proof.ts';

const TRUTH_SOURCE = 'docs/plans/2026-07-20-surface-execution-browser-computer-use.md';
const TRUSTED_ACCEPTANCE_ROOT = 'docs/acceptance';

function usage(): void {
  console.log(`Surface Execution T0/T1 fail-closed gate report

Usage:
  npx tsx scripts/acceptance/surface-execution-gate-report.ts --out <path> [options]

Options:
  --out <path>   Required report file or directory. A directory receives gate-report.json.
  --repo <path>  Repository worktree. Default: current directory.
  --campaign-id <id>
                 Require every proof to belong to this acceptance campaign.
  --campaign-started-at <UTC ISO timestamp>
                 Require proof timestamps at or after this campaign start.
  --json         Print the complete report after writing it.
  --help         Show this help.

All eight canonical proof files must exist, carry boolean assertions, have a
passed status (except a strictly recognized real Computer permission block),
and exactly match the current Surface source fingerprint. Any failed, stale,
missing, or external-blocked evidence writes the report and exits non-zero.`);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const fromDirectory = relative(directory, candidate);
  return fromDirectory === ''
    || (!isAbsolute(fromDirectory)
      && fromDirectory !== '..'
      && !fromDirectory.startsWith(`..${sep}`));
}

function pathExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function symbolicLinkInPath(
  trustedRoot: string,
  pathname: string,
): string | undefined {
  if (!isInsideDirectory(trustedRoot, pathname)) return undefined;
  let current = trustedRoot;
  if (lstatSync(current).isSymbolicLink()) return current;
  const fromRoot = relative(trustedRoot, pathname);
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return current;
  }
  return undefined;
}

function artifactPath(
  repoRoot: string,
  proofDirectory: string,
  declaredPath: string,
): { resolvedPath: string; insideProofDirectory: boolean } {
  const candidates = isAbsolute(declaredPath)
    ? [resolve(declaredPath)]
    : [resolve(proofDirectory, declaredPath), resolve(repoRoot, declaredPath)];
  const resolvedPath = candidates.find((candidate) => {
    return pathExistsWithoutFollowing(candidate) && isInsideDirectory(proofDirectory, candidate);
  }) || candidates[0];
  return {
    resolvedPath,
    insideProofDirectory: isInsideDirectory(proofDirectory, resolvedPath),
  };
}

function artifactFact(
  repoRoot: string,
  proofDirectory: string,
  record: unknown,
  requirement: ArtifactRequirement,
): ArtifactFact {
  const fileField = requirement.fileField || 'path';
  const shaField = requirement.sha256Field || 'sha256';
  const bytesField = requirement.bytesField || 'bytes';
  if (!isRecord(record)) return { exists: false, insideProofDirectory: false };
  const declaredPath = typeof record[fileField] === 'string' ? record[fileField] : undefined;
  const expectedSha256 = typeof record[shaField] === 'string' ? record[shaField] : undefined;
  const expectedBytes = typeof record[bytesField] === 'number' ? record[bytesField] : undefined;
  if (!declaredPath) {
    return {
      declaredPath,
      expectedSha256,
      expectedBytes,
      exists: false,
      insideProofDirectory: false,
    };
  }
  const resolved = artifactPath(repoRoot, proofDirectory, declaredPath);
  if (!resolved.insideProofDirectory || !pathExistsWithoutFollowing(resolved.resolvedPath)) {
    return { declaredPath, expectedSha256, expectedBytes, exists: false, ...resolved };
  }
  try {
    const symbolicLink = symbolicLinkInPath(proofDirectory, resolved.resolvedPath);
    const canonicalProofDirectory = realpathSync(proofDirectory);
    const canonicalArtifactPath = realpathSync(resolved.resolvedPath);
    const insideProofDirectory = isInsideDirectory(
      canonicalProofDirectory,
      canonicalArtifactPath,
    );
    if (symbolicLink) {
      return {
        declaredPath,
        expectedSha256,
        expectedBytes,
        exists: false,
        resolvedPath: resolved.resolvedPath,
        insideProofDirectory,
        readError: `artifact path contains a symbolic link: ${symbolicLink}`,
      };
    }
    if (!insideProofDirectory) {
      return {
        declaredPath,
        expectedSha256,
        expectedBytes,
        exists: false,
        resolvedPath: resolved.resolvedPath,
        insideProofDirectory: false,
        readError: 'artifact realpath resolves outside its canonical proof directory',
      };
    }
    const stat = statSync(canonicalArtifactPath);
    if (!stat.isFile()) {
      return {
        declaredPath,
        expectedSha256,
        expectedBytes,
        exists: false,
        resolvedPath: resolved.resolvedPath,
        insideProofDirectory,
      };
    }
    const buffer = readFileSync(canonicalArtifactPath);
    return {
      declaredPath,
      expectedSha256,
      expectedBytes,
      exists: true,
      actualSha256: sha256(buffer),
      actualBytes: buffer.length,
      mtimeMs: stat.mtimeMs,
      resolvedPath: resolved.resolvedPath,
      insideProofDirectory,
    };
  } catch (error) {
    return {
      declaredPath,
      expectedSha256,
      expectedBytes,
      exists: false,
      readError: error instanceof Error ? error.message : String(error),
      ...resolved,
    };
  }
}

export function loadProof(
  repoRoot: string,
  id: SurfaceGateProofId,
  requirements: ArtifactRequirement[],
): LoadedSurfaceProof {
  const path = SURFACE_GATE_PROOF_PATHS[id];
  const absolutePath = resolve(repoRoot, path);
  const trustedAcceptanceRoot = resolve(repoRoot, TRUSTED_ACCEPTANCE_ROOT);
  if (!isInsideDirectory(trustedAcceptanceRoot, absolutePath)) {
    return { id, path, loadError: 'proof path resolves outside the trusted docs/acceptance root' };
  }
  if (!pathExistsWithoutFollowing(absolutePath)) {
    return { id, path, loadError: 'proof file does not exist' };
  }
  let document: unknown;
  let proofFileMtimeMs: number;
  try {
    const symbolicLink = symbolicLinkInPath(repoRoot, absolutePath);
    if (symbolicLink) {
      return {
        id,
        path,
        loadError: `proof path contains a symbolic link: ${symbolicLink}`,
      };
    }
    const canonicalAcceptanceRoot = realpathSync(trustedAcceptanceRoot);
    const canonicalProofPath = realpathSync(absolutePath);
    if (!isInsideDirectory(canonicalAcceptanceRoot, canonicalProofPath)) {
      return {
        id,
        path,
        loadError: 'proof realpath resolves outside the trusted docs/acceptance root',
      };
    }
    const proofStat = statSync(canonicalProofPath);
    if (!proofStat.isFile()) {
      return { id, path, loadError: 'proof path is not a regular file' };
    }
    proofFileMtimeMs = proofStat.mtimeMs;
    document = JSON.parse(readFileSync(canonicalProofPath, 'utf8'));
  } catch (error) {
    return {
      id,
      path,
      loadError: `proof JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const proofDirectory = dirname(absolutePath);
  const artifactFacts = Object.fromEntries(requirements.map((requirement) => [
    artifactRequirementKey(requirement),
    artifactRecords(document, requirement).map((record) => (
      artifactFact(repoRoot, proofDirectory, record, requirement)
    )),
  ]));
  return { id, path, document, proofFileMtimeMs, artifactFacts };
}

function gitCommand(repoRoot: string, args: string[]): { stdout: string; evidence: {
  argv: string[];
  stdout: string;
  exitCode: 0;
} } {
  const stdout = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  return {
    stdout,
    evidence: { argv: ['git', ...args], stdout, exitCode: 0 },
  };
}

function gitEvidence(repoRoot: string): SurfaceGateGitEvidence {
  const head = gitCommand(repoRoot, ['rev-parse', 'HEAD']);
  const originMain = gitCommand(repoRoot, ['rev-parse', 'origin/main']);
  const mergeBase = gitCommand(repoRoot, ['merge-base', 'HEAD', 'origin/main']);
  const worktree = gitCommand(repoRoot, ['rev-parse', '--show-toplevel']);
  return {
    worktree: worktree.stdout,
    head: head.stdout,
    originMain: originMain.stdout,
    mergeBase: mergeBase.stdout,
    commands: [head.evidence, originMain.evidence, mergeBase.evidence, worktree.evidence],
  };
}

function outputFile(repoRoot: string, requested: string): string {
  const path = resolve(repoRoot, requested);
  if (extname(path).toLowerCase() === '.json') {
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }
  mkdirSync(path, { recursive: true });
  return join(path, 'gate-report.json');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const repoRoot = resolve(getStringOption(args, 'repo') || process.cwd());
  const reportPath = outputFile(repoRoot, requireStringOption(args, 'out'));
  const campaign = parseSurfaceAcceptanceCampaign({
    id: hasFlag(args, 'campaign-id')
      ? requireStringOption(args, 'campaign-id')
      : undefined,
    startedAt: hasFlag(args, 'campaign-started-at')
      ? requireStringOption(args, 'campaign-started-at')
      : undefined,
  });
  const requirements = collectArtifactRequirements();
  const proofIds = Object.keys(SURFACE_GATE_PROOF_PATHS) as SurfaceGateProofId[];
  const proofs = Object.fromEntries(proofIds.map((id) => [
    id,
    loadProof(repoRoot, id, requirements[id] || []),
  ]));
  const report = evaluateSurfaceGateReport({
    generatedAt: new Date().toISOString(),
    truthSource: TRUTH_SOURCE,
    invocation: [process.execPath, ...process.argv.slice(1)],
    campaign,
    currentSourceFingerprint: surfaceAcceptanceSourceFingerprint(repoRoot),
    git: gitEvidence(repoRoot),
    proofs,
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (hasFlag(args, 'json')) printJson(report);
  else printKeyValue('Surface Execution gate report', [
    ['status', report.overall.status],
    ['exitCode', report.overall.exitCode],
    ['campaign', report.campaign?.id],
    ['T0 passed', `${report.t0.filter((gate) => gate.status === 'passed').length}/${report.t0.length}`],
    ['T1 passed', `${report.t1.filter((gate) => gate.status === 'passed').length}/${report.t1.length}`],
    ['report', reportPath],
  ]);
  process.exitCode = report.overall.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(finishWithError);
}
