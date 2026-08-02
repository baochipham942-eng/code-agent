import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

export const CLOSURE_SCHEMA_VERSION = 1;
export const TASK_CLOSURE_KIND = 'better-harness.task-closure';
export const DELIVERY_CLOSURE_KIND = 'better-harness.delivery-closure';
export const CLOSURE_EVIDENCE_MARKER = 'BETTER_HARNESS_EVIDENCE_V1 ';
export const DELIVERY_STATUSES = ['VERIFIED', 'BLOCKED', 'RECOVERY_REQUIRED'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item))
    ? value.map((item) => item.trim())
    : null;
}

function failure(code, message, details = {}) {
  return { code, message, ...details };
}

function git(repoRoot, args, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? '');
    throw new Error(`git ${args.join(' ')} exited with ${result.status}: ${stderr.trim()}`);
  }
  return result.stdout;
}

function normalizeRepoPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathMatchesPrefix(file, prefix) {
  const normalizedFile = normalizeRepoPath(file);
  const normalizedPrefix = normalizeRepoPath(prefix);
  return normalizedFile === normalizedPrefix || normalizedFile.startsWith(`${normalizedPrefix}/`);
}

function hashUntrackedFile(repoRoot, relativePath, hash) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const stat = fs.lstatSync(absolutePath);
  hash.update(`\0${relativePath}\0${stat.mode}\0`);
  if (stat.isSymbolicLink()) {
    hash.update(fs.readlinkSync(absolutePath));
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`untracked diff entry is not a regular file or symlink: ${relativePath}`);
  }
  hash.update(fs.readFileSync(absolutePath));
}

export function collectDiffEvidence(repoRoot, baseRef) {
  const requestedBaseRef = nonEmptyString(baseRef);
  if (!requestedBaseRef) throw new Error('baseRef is required');

  const baseCommit = git(repoRoot, ['rev-parse', '--verify', `${requestedBaseRef}^{commit}`]).trim();
  const headCommit = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const tracked = String(git(repoRoot, ['diff', '--name-only', '-z', requestedBaseRef, '--']))
    .split('\0')
    .filter(Boolean);
  const untracked = String(git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  const changedPaths = [...new Set([...tracked, ...untracked])].sort();
  const binaryDiff = git(repoRoot, ['diff', '--binary', '--full-index', requestedBaseRef, '--'], null);
  const hash = createHash('sha256');
  hash.update(`base:${baseCommit}\nhead:${headCommit}\n`);
  hash.update(binaryDiff);
  for (const relativePath of untracked.sort()) hashUntrackedFile(repoRoot, relativePath, hash);

  return {
    baseRef: requestedBaseRef,
    baseCommit,
    headCommit,
    changedPaths,
    diffSha256: hash.digest('hex'),
  };
}

export function classifyAcceptanceScript(packageScript) {
  if (packageScript === 'gates:local') return 'gate';
  if (packageScript.startsWith('acceptance:')) return 'acceptance';
  if (packageScript.startsWith('release:') || packageScript.includes(':release:')) return 'release';
  if (
    packageScript.startsWith('smoke:')
    || packageScript.endsWith(':smoke')
    || packageScript.includes(':smoke:')
  ) return 'smoke';
  return null;
}

export function runPackageScript(repoRoot, packageScript) {
  const result = spawnSync('npm', ['run', packageScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function commandEvidence(definition, result) {
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  return {
    id: definition.id,
    packageScript: definition.packageScript,
    reason: definition.reason,
    exitCode,
    signal: result.signal ?? null,
    status: exitCode === 0 ? 'PASSED' : 'FAILED',
    outputSha256: stableHash({ stdout, stderr }),
    stdoutTail: stdout.slice(-2_000),
    stderrTail: stderr.slice(-2_000),
  };
}

function skippedCommandEvidence(definition, reason) {
  return {
    id: definition.id,
    packageScript: definition.packageScript,
    reason: definition.reason,
    exitCode: null,
    signal: null,
    status: 'NOT_RUN',
    skippedReason: reason,
  };
}

function validateCommandDefinitions(value, label, packageScripts, { acceptance = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one command`);
  }
  const ids = new Set();
  return value.map((raw, index) => {
    const entry = asRecord(raw);
    const id = nonEmptyString(entry?.id);
    const packageScript = nonEmptyString(entry?.packageScript);
    const reason = nonEmptyString(entry?.reason);
    if (!id || !packageScript || !reason) {
      throw new Error(`${label}[${index}] requires id, packageScript, and reason`);
    }
    if (ids.has(id)) throw new Error(`${label} contains duplicate id ${id}`);
    ids.add(id);
    if (!(packageScript in packageScripts)) {
      throw new Error(`${label}[${index}] references missing package script ${packageScript}`);
    }
    const source = acceptance ? classifyAcceptanceScript(packageScript) : undefined;
    if (acceptance && !source) {
      throw new Error(`${label}[${index}] must use an acceptance, release, smoke, or gates:local package script`);
    }
    const readbacks = acceptance ? validateReadbackDefinitions(entry.readbacks, `${label}[${index}].readbacks`) : undefined;
    return { id, packageScript, reason, ...(source ? { source } : {}), ...(readbacks ? { readbacks } : {}) };
  });
}

function validateReadbackDefinitions(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one readback`);
  }
  return value.map((raw, index) => {
    const entry = asRecord(raw);
    const readbackPath = nonEmptyString(entry?.path);
    const contains = entry?.contains === undefined ? [] : stringArray(entry.contains);
    if (!readbackPath || entry?.nonEmpty !== true || !contains) {
      throw new Error(`${label}[${index}] requires path, nonEmpty=true, and an optional string contains array`);
    }
    return { path: readbackPath, nonEmpty: true, contains };
  });
}

function validateMappings(value, checkIds, acceptanceIds) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('scopeMappings must contain at least one mapping');
  }
  return value.map((raw, index) => {
    const entry = asRecord(raw);
    const pathPrefixes = stringArray(entry?.pathPrefixes);
    const mappedCheckIds = stringArray(entry?.checkIds);
    const mappedAcceptanceIds = stringArray(entry?.acceptanceIds);
    if (!pathPrefixes?.length || !mappedCheckIds?.length || !mappedAcceptanceIds?.length) {
      throw new Error(`scopeMappings[${index}] requires non-empty pathPrefixes, checkIds, and acceptanceIds`);
    }
    for (const id of mappedCheckIds) {
      if (!checkIds.has(id)) throw new Error(`scopeMappings[${index}] references unknown check ${id}`);
    }
    for (const id of mappedAcceptanceIds) {
      if (!acceptanceIds.has(id)) throw new Error(`scopeMappings[${index}] references unknown acceptance ${id}`);
    }
    return { pathPrefixes, checkIds: mappedCheckIds, acceptanceIds: mappedAcceptanceIds };
  });
}

function readback(repoRoot, definition) {
  const absolutePath = path.isAbsolute(definition.path)
    ? definition.path
    : path.resolve(repoRoot, definition.path);
  if (!fs.existsSync(absolutePath)) {
    return { ...definition, status: 'FAILED', failure: 'missing_file' };
  }
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) return { ...definition, status: 'FAILED', failure: 'not_a_file' };
  const content = fs.readFileSync(absolutePath);
  const text = content.toString('utf8');
  if (definition.nonEmpty && content.length === 0) {
    return { ...definition, bytes: 0, status: 'FAILED', failure: 'empty_file' };
  }
  const missingText = definition.contains.filter((expected) => !text.includes(expected));
  return {
    ...definition,
    bytes: content.length,
    sha256: sha256(content),
    status: missingText.length === 0 ? 'VERIFIED' : 'FAILED',
    ...(missingText.length ? { failure: 'expected_text_missing', missingText } : {}),
  };
}

function taskComparisonKey(spec, checks, acceptance, mappings) {
  return stableHash({
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    evidenceProfile: spec.evidenceProfile,
    checks: checks.map(({ id, packageScript }) => ({ id, packageScript })),
    acceptance: acceptance.map(({ id, packageScript, source, readbacks }) => ({
      id,
      packageScript,
      source,
      readbacks: readbacks.map(({ path: readbackPath, nonEmpty, contains }) => ({
        path: readbackPath,
        nonEmpty,
        contains,
      })),
    })),
    mappings,
  });
}

function buildTaskReportBase(spec, diffEvidence, checks, acceptance, mappings, generatedAt) {
  return {
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    kind: TASK_CLOSURE_KIND,
    taskId: spec.taskId,
    evidenceProfile: spec.evidenceProfile,
    comparisonKey: taskComparisonKey(spec, checks, acceptance, mappings),
    generatedAt,
    repository: diffEvidence,
    scopeMappings: mappings,
  };
}

function sameRepositorySnapshot(left, right) {
  return left.diffSha256 === right.diffSha256
    && left.baseCommit === right.baseCommit
    && left.headCommit === right.headCommit
    && JSON.stringify(left.changedPaths) === JSON.stringify(right.changedPaths);
}

export async function buildTaskClosure(specInput, options = {}) {
  const spec = asRecord(specInput);
  if (!spec || spec.schemaVersion !== CLOSURE_SCHEMA_VERSION) {
    throw new Error(`task closure spec schemaVersion must be ${CLOSURE_SCHEMA_VERSION}`);
  }
  const taskId = nonEmptyString(spec.taskId);
  const evidenceProfile = nonEmptyString(spec.evidenceProfile);
  const baseRef = nonEmptyString(spec.baseRef);
  if (!taskId || !evidenceProfile || !baseRef) {
    throw new Error('task closure spec requires taskId, evidenceProfile, and baseRef');
  }
  spec.taskId = taskId;
  spec.evidenceProfile = evidenceProfile;

  const repoRoot = options.repoRoot ?? process.cwd();
  const packageScripts = options.packageScripts
    ?? JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts
    ?? {};
  const checks = validateCommandDefinitions(spec.checks, 'checks', packageScripts);
  const acceptance = validateCommandDefinitions(spec.acceptance, 'acceptance', packageScripts, { acceptance: true });
  const mappings = validateMappings(
    spec.scopeMappings,
    new Set(checks.map(({ id }) => id)),
    new Set(acceptance.map(({ id }) => id)),
  );
  const collectRepository = options.collectDiffEvidence
    ?? (() => collectDiffEvidence(repoRoot, baseRef));
  const diffEvidence = options.diffEvidence ?? collectRepository();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const reportBase = buildTaskReportBase(spec, diffEvidence, checks, acceptance, mappings, generatedAt);
  const failures = [];

  if (diffEvidence.changedPaths.length === 0) {
    failures.push(failure('empty_diff', 'No final diff exists to verify'));
  }
  for (const changedPath of diffEvidence.changedPaths) {
    const matching = mappings.filter((mapping) => mapping.pathPrefixes.some((prefix) => pathMatchesPrefix(changedPath, prefix)));
    if (matching.length === 0) {
      failures.push(failure('unmapped_diff_path', `No check and acceptance mapping covers ${changedPath}`, { path: changedPath }));
    }
  }

  if (failures.length > 0) {
    return {
      ...reportBase,
      status: 'BLOCKED',
      checks: checks.map((entry) => skippedCommandEvidence(entry, 'scope_mapping_failed')),
      acceptance: acceptance.map((entry) => ({
        ...skippedCommandEvidence(entry, 'scope_mapping_failed'),
        source: entry.source,
        readbacks: [],
      })),
      failures,
    };
  }

  const execute = options.runPackageScript ?? ((packageScript) => runPackageScript(repoRoot, packageScript));
  const checkEvidence = [];
  for (const definition of checks) {
    const result = await execute(definition.packageScript);
    const evidence = commandEvidence(definition, result);
    checkEvidence.push(evidence);
    if (evidence.status === 'FAILED') {
      failures.push(failure('focused_check_failed', `${definition.packageScript} exited with ${evidence.exitCode ?? 'no status'}`, {
        checkId: definition.id,
        exitCode: evidence.exitCode,
      }));
      break;
    }
  }
  for (const definition of checks.slice(checkEvidence.length)) {
    checkEvidence.push(skippedCommandEvidence(definition, 'previous_check_failed'));
  }

  const acceptanceEvidence = [];
  if (failures.length === 0) {
    for (const definition of acceptance) {
      const result = await execute(definition.packageScript);
      const evidence = commandEvidence(definition, result);
      const readbacks = evidence.status === 'PASSED'
        ? definition.readbacks.map((entry) => readback(repoRoot, entry))
        : [];
      const readbackFailed = readbacks.some((entry) => entry.status !== 'VERIFIED');
      const status = evidence.status === 'PASSED' && !readbackFailed ? 'VERIFIED' : 'FAILED';
      acceptanceEvidence.push({ ...evidence, source: definition.source, status, readbacks });
      if (evidence.status === 'FAILED') {
        failures.push(failure('acceptance_command_failed', `${definition.packageScript} exited with ${evidence.exitCode ?? 'no status'}`, {
          acceptanceId: definition.id,
          exitCode: evidence.exitCode,
        }));
        break;
      }
      if (readbackFailed) {
        failures.push(failure('acceptance_readback_failed', `Acceptance readback failed for ${definition.id}`, {
          acceptanceId: definition.id,
          failedReadbacks: readbacks.filter((entry) => entry.status !== 'VERIFIED').map((entry) => entry.path),
        }));
        break;
      }
    }
  }
  for (const definition of acceptance.slice(acceptanceEvidence.length)) {
    acceptanceEvidence.push({
      ...skippedCommandEvidence(definition, failures.length ? 'previous_verification_failed' : 'not_selected'),
      source: definition.source,
      readbacks: [],
    });
  }

  const postVerificationRepository = options.postVerificationDiffEvidence
    ?? (options.diffEvidence ? diffEvidence : collectRepository());
  if (!sameRepositorySnapshot(diffEvidence, postVerificationRepository)) {
    failures.push(failure(
      'task_closure_snapshot_drift',
      'Repository state changed while focused checks or acceptance were running',
      {
        checkedDiffSha256: diffEvidence.diffSha256,
        finalDiffSha256: postVerificationRepository.diffSha256,
      },
    ));
  }

  return {
    ...reportBase,
    status: failures.length === 0 ? 'VERIFIED' : 'BLOCKED',
    checks: checkEvidence,
    acceptance: acceptanceEvidence,
    postVerificationRepository,
    failures,
  };
}

function fingerprintArtifact(repoRoot, artifactPath) {
  const absolutePath = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(repoRoot, artifactPath);
  if (!fs.existsSync(absolutePath)) return { path: artifactPath, status: 'MISSING' };
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    const content = fs.readFileSync(absolutePath);
    return { path: artifactPath, type: 'file', bytes: content.length, sha256: sha256(content), status: 'FINGERPRINTED' };
  }
  if (!stat.isDirectory()) return { path: artifactPath, status: 'UNSUPPORTED' };
  const entries = [];
  const visit = (directory, relativePrefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absoluteEntry = path.join(directory, name);
      const relativeEntry = path.posix.join(relativePrefix, name);
      const entryStat = fs.lstatSync(absoluteEntry);
      if (entryStat.isDirectory()) visit(absoluteEntry, relativeEntry);
      else if (entryStat.isFile()) entries.push({ path: relativeEntry, sha256: sha256(fs.readFileSync(absoluteEntry)) });
      else if (entryStat.isSymbolicLink()) entries.push({ path: relativeEntry, symlink: fs.readlinkSync(absoluteEntry) });
    }
  };
  visit(absolutePath);
  return { path: artifactPath, type: 'directory', files: entries.length, sha256: stableHash(entries), status: 'FINGERPRINTED' };
}

function validApprovalBoundary(value) {
  const boundary = asRecord(value);
  const currentScope = stringArray(boundary?.currentScope);
  const requiresApproval = stringArray(boundary?.requiresApproval);
  const prohibitedActions = stringArray(boundary?.prohibitedActions);
  if (!currentScope || !requiresApproval || !prohibitedActions || currentScope.length === 0) return null;
  return { currentScope, requiresApproval, prohibitedActions };
}

export function buildDeliveryClosure(specInput, options = {}) {
  const spec = asRecord(specInput);
  if (!spec || spec.schemaVersion !== CLOSURE_SCHEMA_VERSION) {
    throw new Error(`delivery closure spec schemaVersion must be ${CLOSURE_SCHEMA_VERSION}`);
  }
  const deliveryId = nonEmptyString(spec.deliveryId);
  const evidenceProfile = nonEmptyString(spec.evidenceProfile);
  if (!deliveryId || !evidenceProfile) {
    throw new Error('delivery closure spec requires deliveryId and evidenceProfile');
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const taskClosure = asRecord(options.taskClosure ?? spec.taskClosure);
  const deliverable = asRecord(spec.deliverable);
  const approvalBoundary = validApprovalBoundary(spec.approvalBoundary);
  const failures = [];
  const recoveryActions = stringArray(spec.recoveryActions) ?? [];

  if (!taskClosure || taskClosure.kind !== TASK_CLOSURE_KIND || taskClosure.schemaVersion !== CLOSURE_SCHEMA_VERSION) {
    failures.push(failure('task_closure_missing', 'A verified task closure report is required; handoff is not completion evidence'));
  } else if (taskClosure.status !== 'VERIFIED') {
    failures.push(failure('task_closure_not_verified', `Task closure status is ${taskClosure.status ?? 'missing'}`));
  }

  const acceptanceResults = Array.isArray(taskClosure?.acceptance) ? taskClosure.acceptance : [];
  if (acceptanceResults.length === 0 || acceptanceResults.some((entry) => entry?.status !== 'VERIFIED')) {
    failures.push(failure('acceptance_not_verified', 'Every recorded acceptance result must be VERIFIED'));
  }

  if (!approvalBoundary) {
    failures.push(failure('approval_boundary_missing', 'approvalBoundary must explicitly record currentScope, requiresApproval, and prohibitedActions'));
  }

  let commit = null;
  const commitRef = nonEmptyString(deliverable?.commitRef);
  if (!commitRef) {
    failures.push(failure('commit_fingerprint_missing', 'deliverable.commitRef is required'));
  } else {
    try {
      const resolveCommit = options.resolveCommit ?? ((ref) => git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim());
      commit = { ref: commitRef, sha: resolveCommit(commitRef) };
    } catch (error) {
      failures.push(failure('commit_fingerprint_failed', error instanceof Error ? error.message : String(error), { commitRef }));
    }
  }

  const artifactPaths = deliverable?.artifactPaths === undefined ? [] : stringArray(deliverable.artifactPaths);
  if (!artifactPaths) throw new Error('deliverable.artifactPaths must be a string array when provided');
  const artifacts = artifactPaths.map((artifactPath) => fingerprintArtifact(repoRoot, artifactPath));
  for (const artifact of artifacts) {
    if (artifact.status !== 'FINGERPRINTED') {
      failures.push(failure('artifact_fingerprint_failed', `Artifact ${artifact.path} is ${artifact.status.toLowerCase()}`, { path: artifact.path }));
    }
  }

  let currentRepository = null;
  if (taskClosure?.repository?.baseRef) {
    try {
      const collect = options.collectDiffEvidence ?? ((baseRef) => collectDiffEvidence(repoRoot, baseRef));
      currentRepository = collect(taskClosure.repository.baseRef);
      if (
        currentRepository.diffSha256 !== taskClosure.repository.diffSha256
        || currentRepository.headCommit !== taskClosure.repository.headCommit
        || JSON.stringify(currentRepository.changedPaths) !== JSON.stringify(taskClosure.repository.changedPaths)
      ) {
        failures.push(failure('task_closure_snapshot_drift', 'Repository state changed after task closure evidence was recorded'));
        if (!recoveryActions.includes('rerun task closure against the final repository state')) {
          recoveryActions.push('rerun task closure against the final repository state');
        }
      }
    } catch (error) {
      failures.push(failure('task_closure_snapshot_unreadable', error instanceof Error ? error.message : String(error)));
    }
  }

  const explicitFailureReason = nonEmptyString(spec.failureReason);
  if (explicitFailureReason) failures.push(failure('declared_delivery_failure', explicitFailureReason));
  const status = failures.length === 0
    ? 'VERIFIED'
    : recoveryActions.length > 0
      ? 'RECOVERY_REQUIRED'
      : 'BLOCKED';
  const comparisonKey = stableHash({
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    evidenceProfile,
    taskComparisonKey: taskClosure?.comparisonKey ?? null,
    artifactPaths,
    commitRef,
  });

  return {
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    kind: DELIVERY_CLOSURE_KIND,
    deliveryId,
    evidenceProfile,
    comparisonKey,
    generatedAt,
    status,
    taskClosure: taskClosure ? {
      taskId: taskClosure.taskId,
      status: taskClosure.status,
      comparisonKey: taskClosure.comparisonKey,
      diffSha256: taskClosure.repository?.diffSha256,
    } : null,
    deliverable: { commit, artifacts, repository: currentRepository },
    acceptanceResults: acceptanceResults.map((entry) => ({
      id: entry.id,
      packageScript: entry.packageScript,
      source: entry.source,
      exitCode: entry.exitCode,
      status: entry.status,
      readbacks: entry.readbacks,
    })),
    approvalBoundary,
    handoff: spec.handoff ? { value: spec.handoff, completionEvidence: false } : null,
    failureReason: explicitFailureReason,
    recoveryActions,
    failures,
  };
}

export function writeJsonReport(outputPath, report) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { path: resolved, sha256: sha256(fs.readFileSync(resolved)) };
}

function failureCodes(report) {
  return Array.isArray(report?.failures)
    ? report.failures.map((entry) => nonEmptyString(entry?.code)).filter(Boolean)
    : [];
}

function taskEvidence(report, reportSha256) {
  const repository = asRecord(report?.repository);
  return {
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    kind: TASK_CLOSURE_KIND,
    status: report?.status,
    taskId: report?.taskId ?? null,
    evidenceProfile: report?.evidenceProfile ?? null,
    comparisonKey: report?.comparisonKey ?? null,
    reportSha256,
    repository: repository ? {
      baseCommit: repository.baseCommit ?? null,
      headCommit: repository.headCommit ?? null,
      diffSha256: repository.diffSha256 ?? null,
      changedPaths: Array.isArray(repository.changedPaths) ? repository.changedPaths : [],
    } : null,
    checks: Array.isArray(report?.checks) ? report.checks.map((entry) => ({
      id: entry?.id ?? null,
      exitCode: entry?.exitCode ?? null,
      status: entry?.status ?? null,
    })) : [],
    acceptance: Array.isArray(report?.acceptance) ? report.acceptance.map((entry) => ({
      id: entry?.id ?? null,
      exitCode: entry?.exitCode ?? null,
      status: entry?.status ?? null,
      readbacksVerified: Array.isArray(entry?.readbacks)
        && entry.readbacks.length > 0
        && entry.readbacks.every((readbackEntry) => readbackEntry?.status === 'VERIFIED'),
    })) : [],
    failureCodes: failureCodes(report),
  };
}

function deliveryEvidence(report, reportSha256) {
  const taskClosure = asRecord(report?.taskClosure);
  const repository = asRecord(report?.deliverable?.repository);
  return {
    schemaVersion: CLOSURE_SCHEMA_VERSION,
    kind: DELIVERY_CLOSURE_KIND,
    status: report?.status,
    deliveryId: report?.deliveryId ?? null,
    evidenceProfile: report?.evidenceProfile ?? null,
    comparisonKey: report?.comparisonKey ?? null,
    reportSha256,
    taskClosure: taskClosure ? {
      taskId: taskClosure.taskId ?? null,
      status: taskClosure.status ?? null,
      comparisonKey: taskClosure.comparisonKey ?? null,
      diffSha256: taskClosure.diffSha256 ?? null,
    } : null,
    deliverable: {
      commitSha: report?.deliverable?.commit?.sha ?? null,
      diffSha256: repository?.diffSha256 ?? null,
      artifacts: Array.isArray(report?.deliverable?.artifacts)
        ? report.deliverable.artifacts.map((entry) => ({
            status: entry?.status ?? null,
            sha256: entry?.sha256 ?? null,
          }))
        : [],
    },
    acceptance: Array.isArray(report?.acceptanceResults) ? report.acceptanceResults.map((entry) => ({
      id: entry?.id ?? null,
      exitCode: entry?.exitCode ?? null,
      status: entry?.status ?? null,
      readbacksVerified: Array.isArray(entry?.readbacks)
        && entry.readbacks.length > 0
        && entry.readbacks.every((readbackEntry) => readbackEntry?.status === 'VERIFIED'),
    })) : [],
    approvalBoundaryPresent: Boolean(report?.approvalBoundary),
    handoffCompletionEvidence: report?.handoff?.completionEvidence ?? false,
    failureReasonPresent: Boolean(nonEmptyString(report?.failureReason)),
    recoveryActionCount: Array.isArray(report?.recoveryActions) ? report.recoveryActions.length : 0,
    failureCodes: failureCodes(report),
  };
}

export function buildClosureEvidenceEvent(report, reportSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(reportSha256 ?? ''))) {
    throw new Error('closure evidence requires a SHA-256 report digest');
  }
  if (report?.kind === TASK_CLOSURE_KIND) return taskEvidence(report, reportSha256);
  if (report?.kind === DELIVERY_CLOSURE_KIND) return deliveryEvidence(report, reportSha256);
  throw new Error(`unsupported closure evidence kind ${report?.kind ?? 'missing'}`);
}

export function formatClosureEvidenceMarker(report, reportSha256) {
  return `${CLOSURE_EVIDENCE_MARKER}${JSON.stringify(buildClosureEvidenceEvent(report, reportSha256))}`;
}
