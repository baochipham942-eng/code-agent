import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { diffLines } from 'diff';
import type {
  TurnDiffEventData,
  TurnDiffFileChange,
} from '../../../shared/contract/turnDiff';
import { NETWORK_TOOL_TIMEOUTS } from '../../../shared/constants';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = NETWORK_TOOL_TIMEOUTS.GIT_OPERATION;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const TURN_DIFF_CREDENTIAL_PATTERN = /(?:\bsk-[A-Za-z0-9._-]{5,}|\bAIza[0-9A-Za-z_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[-_]?key|token|secret|password|passwd|authorization|credential|private[-_]?key)\b\s*[=:]\s*\S+)/i;

async function git(
  workingDir: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workingDir,
    timeout: GIT_TIMEOUT,
    maxBuffer: EXEC_MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

async function resolveRepoRoot(workingDir: string): Promise<string | null> {
  try {
    const root = (await git(workingDir, ['rev-parse', '--show-toplevel'])).trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

function splitNullTerminated(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

/**
 * Return every tracked or untracked path currently changed relative to HEAD.
 * This is the same disk/Git truth source used by workspace patch capture, but
 * exposes paths so Bash/scripts can join the normal mutation tracker.
 */
async function listWorkspaceChangedPaths(workingDir: string): Promise<string[]> {
  const repoRoot = await resolveRepoRoot(workingDir);
  if (!repoRoot) return [];

  let tracked: string[];
  try {
    tracked = splitNullTerminated(await git(repoRoot, [
      'diff', '--name-only', '-z', 'HEAD', '--',
    ]));
  } catch {
    try {
      tracked = splitNullTerminated(await git(repoRoot, [
        'diff', '--name-only', '-z', '--',
      ]));
    } catch {
      tracked = [];
    }
  }

  let untracked: string[];
  try {
    untracked = splitNullTerminated(await git(repoRoot, [
      'ls-files', '--others', '--exclude-standard', '-z',
    ]));
  } catch {
    untracked = [];
  }

  return [...new Set([...tracked, ...untracked])]
    .map((filePath) => path.resolve(repoRoot, filePath));
}

export type WorkspaceMutationSnapshot = ReadonlyMap<string, string>;

async function fingerprintWorkspacePath(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return `non-file:${stat.mode}:${stat.size}`;
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/** Snapshot current Git-visible mutations so a later tool can claim only its own disk delta. */
export async function captureWorkspaceMutationSnapshot(
  workingDir: string,
): Promise<WorkspaceMutationSnapshot> {
  const paths = await listWorkspaceChangedPaths(workingDir);
  return new Map(await Promise.all(paths.map(async (filePath) => (
    [filePath, await fingerprintWorkspacePath(filePath)] as const
  ))));
}

/** Return paths whose Git-visible state changed after the supplied snapshot. */
export async function listWorkspacePathsChangedSince(
  workingDir: string,
  before: WorkspaceMutationSnapshot,
): Promise<string[]> {
  const after = await captureWorkspaceMutationSnapshot(workingDir);
  const candidates = new Set([...before.keys(), ...after.keys()]);
  return [...candidates].filter((filePath) => before.get(filePath) !== after.get(filePath));
}

function isInsideRoot(repoRoot: string, absolutePath: string): boolean {
  const relative = path.relative(repoRoot, absolutePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveTrackedPath(repoRoot: string, workingDir: string, candidate: string): string | null {
  const direct = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workingDir, candidate);
  if (isInsideRoot(repoRoot, direct)) return direct;

  // NudgeManager historically strips the leading slash from absolute paths.
  // Recover that legacy representation without changing its other consumers.
  const rootWithoutSlash = repoRoot.replace(/^[/\\]+/, '');
  const normalizedCandidate = candidate.replace(/^[/\\]+/, '');
  if (normalizedCandidate.startsWith(`${rootWithoutSlash}${path.sep}`)) {
    const recovered = path.resolve(path.parse(repoRoot).root, normalizedCandidate);
    if (isInsideRoot(repoRoot, recovered)) return recovered;
  }
  return null;
}

async function readCurrentText(absolutePath: string): Promise<{ exists: boolean; text: string } | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) return null;
    return { exists: true, text: buffer.toString('utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { exists: false, text: '' };
    return null;
  }
}

async function readHeadText(repoRoot: string, relativePath: string): Promise<{ exists: boolean; text: string } | null> {
  try {
    const text = await git(repoRoot, ['show', `HEAD:${relativePath}`]);
    if (text.includes('\0')) return null;
    return { exists: true, text };
  } catch {
    return { exists: false, text: '' };
  }
}

function countNonEmptyLines(value: string): number {
  return value.split('\n').filter((line) => line !== '').length;
}

function buildFileChange(
  absolutePath: string,
  before: { exists: boolean; text: string },
  after: { exists: boolean; text: string },
): TurnDiffFileChange | null {
  if (before.exists === after.exists && before.text === after.text) return null;
  if (TURN_DIFF_CREDENTIAL_PATTERN.test(`${before.text}\n${after.text}`)) return null;

  let added = 0;
  let removed = 0;
  for (const change of diffLines(before.text, after.text)) {
    const lines = countNonEmptyLines(change.value);
    if (change.added) added += lines;
    if (change.removed) removed += lines;
  }

  return {
    filePath: absolutePath,
    oldText: before.text,
    newText: after.text,
    added,
    removed,
    isNewFile: !before.exists && after.exists,
    editCount: 1,
  };
}

/** Capture one run's tracked files from disk, relative to the repository HEAD. */
export async function captureTurnDiff(
  workingDir: string,
  turnId: string,
  modifiedPaths: Iterable<string>,
): Promise<TurnDiffEventData | null> {
  const repoRoot = await resolveRepoRoot(workingDir);
  if (!repoRoot) return null;

  const absolutePaths = [...new Set(
    [...modifiedPaths]
      .map((candidate) => resolveTrackedPath(repoRoot, workingDir, candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
  )];

  const files: TurnDiffFileChange[] = [];
  for (const absolutePath of absolutePaths) {
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
    const [before, after] = await Promise.all([
      readHeadText(repoRoot, relativePath),
      readCurrentText(absolutePath),
    ]);
    if (!before || !after) continue;
    const change = buildFileChange(absolutePath, before, after);
    if (change) files.push(change);
  }

  return { turnId, files };
}
