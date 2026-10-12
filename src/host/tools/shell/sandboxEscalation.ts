import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { OsSandboxDecision, OsSandboxPermissionMode } from '../../sandbox/osSandboxPolicy';
import { resolveCanonicalRunPath } from '../../runtime/runContext';
import type { PolicyEnforcer } from '../../security/policyEnforcer';
import { denyConcreteShellWritePath } from './writePathPolicyDeny';

export interface SandboxEscalationEligibilityInput {
  sandboxDecision: Pick<OsSandboxDecision, 'sandboxed'>;
  foreground: boolean;
  pty: boolean;
  background: boolean;
  unattended: boolean;
  writeFence: boolean;
  evalRealRoot: boolean;
  permissionMode: OsSandboxPermissionMode;
  abortSignal: AbortSignal;
  deniedPath?: string;
  /**
   * The denial came from creating a directory. The file gate never offers these;
   * the directory gate requires this flag before it may offer a missing path.
   */
  deniedPathCreatesDirectory?: boolean;
  /**
   * The sandbox can allow one path that does not exist yet (seatbelt literal /
   * subpath; bubblewrap cannot bind a missing path). Gates missing files and
   * missing directories alike.
   */
  newFileGrantSupported: boolean;
  /** Command cwd. User path rules compare workspace-relative spellings against it. */
  workingDirectory: string;
  /**
   * The enforcer ToolExecutor bound for this call (null = no policy file). Never the
   * process singleton: by the time the first run is denied, another workspace may
   * have rebound it. undefined = nobody bound one = hard deny.
   */
  policyEnforcer: PolicyEnforcer | null | undefined;
}

type EscalationTarget = 'file' | 'missing' | 'other';

/**
 * The card grants exactly one file, never a tree: the retry gets a literal
 * write allowance for this path and nothing below it. A directory (existing or
 * about to be created) would need a subtree grant whose descendants no card can
 * list, so directories, symlinks and special files are never offered. A missing
 * file needs an existing parent directory, otherwise the retry cannot create it.
 * The offered path is canonical (symlinks in parent directories resolved): the
 * card shows and the retry grants the file that is actually written, never a
 * workspace-looking spelling of a file outside it.
 */
function escalationTarget(resolvedPath: string): EscalationTarget {
  try {
    return fs.lstatSync(resolvedPath).isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
  }
  try {
    return fs.statSync(path.dirname(resolvedPath)).isDirectory() ? 'missing' : 'other';
  } catch {
    return 'other';
  }
}

type DirectoryEscalationTarget = 'directory' | 'missing-directory' | 'other';

/**
 * The card grants one directory subtree: the retry may write this directory and
 * everything created below it. The granted root is exactly the denied path
 * (canonical), never an ancestor. lstat refuses a symlink as the last
 * component, so a denied symlink spelling is only offered after canonical
 * resolution lands on the real directory. A missing path needs an existing
 * parent plus a mkdir denial and a sandbox that can grant paths that do not
 * exist yet (D3 trial: seatbelt subpath allows creation; bubblewrap cannot).
 */
function directoryEscalationTarget(resolvedPath: string): DirectoryEscalationTarget {
  try {
    return fs.lstatSync(resolvedPath).isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
  }
  try {
    return fs.statSync(path.dirname(resolvedPath)).isDirectory() ? 'missing-directory' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Coarser granularity means coarser red lines (design doc, 边界三): `/`, home
 * itself, every ancestor of home (their subtrees contain home) and every direct
 * child of home (`~/.ssh`, `~/Library`, the data dirs) never open a card.
 */
function directoryEscalationRefused(candidate: string, home: string): boolean {
  if (candidate === path.parse(candidate).root) return true;
  if (candidate === home || home.startsWith(`${candidate}${path.sep}`)) return true;
  return path.dirname(candidate) === home;
}

function writePathPolicyBlocksEscalation(
  deniedPath: string,
  resolvedPath: string,
  workingDirectory: string,
  policyEnforcer: PolicyEnforcer | null,
): boolean {
  try {
    return denyConcreteShellWritePath({
      resolvedPath,
      workingDirectory,
      policyEnforcer,
      pathCandidates: [deniedPath, resolvedPath],
      displayPath: deniedPath,
    }) !== undefined;
  } catch {
    // Unclassifiable paths stay hard-denied. A card would add them to the write grant.
    return true;
  }
}

/** Return the one file that may be offered for a single foreground retry. */
export function shouldOfferEscalation(input: SandboxEscalationEligibilityInput): string | undefined {
  const deniedPath = input.deniedPath;
  if (
    !input.sandboxDecision.sandboxed
    || !input.foreground
    || input.pty
    || input.background
    || input.unattended
    || input.writeFence
    || input.evalRealRoot
    || (input.permissionMode !== 'default' && input.permissionMode !== 'acceptEdits')
    || input.abortSignal.aborted
    || !deniedPath
    || !path.isAbsolute(deniedPath)
  ) {
    return undefined;
  }

  const home = path.resolve(homedir());
  const spelledPath = path.resolve(deniedPath);
  // lstat on the spelled path refuses a symlink as the last component; the canonical path would hide it.
  if (spelledPath === path.parse(spelledPath).root || spelledPath === home || escalationTarget(spelledPath) === 'other') {
    return undefined;
  }
  let resolvedPath: string;
  try {
    resolvedPath = resolveCanonicalRunPath(spelledPath);
  } catch {
    return undefined;
  }
  if (resolvedPath === path.parse(resolvedPath).root || resolvedPath === home) return undefined;
  const target = escalationTarget(resolvedPath);
  if (target === 'other') return undefined;
  if (target === 'missing' && (input.deniedPathCreatesDirectory === true || !input.newFileGrantSupported)) {
    return undefined;
  }
  if (input.policyEnforcer === undefined) return undefined;
  if (writePathPolicyBlocksEscalation(deniedPath, resolvedPath, input.workingDirectory, input.policyEnforcer)) {
    return undefined;
  }
  return resolvedPath;
}

/** Return the one directory subtree that may be offered for a single foreground retry. */
export function shouldOfferDirectoryEscalation(input: SandboxEscalationEligibilityInput): string | undefined {
  const deniedPath = input.deniedPath;
  if (
    !input.sandboxDecision.sandboxed
    || !input.foreground
    || input.pty
    || input.background
    || input.unattended
    || input.writeFence
    || input.evalRealRoot
    || (input.permissionMode !== 'default' && input.permissionMode !== 'acceptEdits')
    || input.abortSignal.aborted
    || !deniedPath
    || !path.isAbsolute(deniedPath)
  ) {
    return undefined;
  }

  const home = path.resolve(homedir());
  const spelledPath = path.resolve(deniedPath);
  // lstat on the spelled path refuses a symlink as the last component; the canonical path would hide it.
  if (directoryEscalationRefused(spelledPath, home) || directoryEscalationTarget(spelledPath) === 'other') {
    return undefined;
  }
  let resolvedPath: string;
  try {
    resolvedPath = resolveCanonicalRunPath(spelledPath);
  } catch {
    return undefined;
  }
  if (directoryEscalationRefused(resolvedPath, home)) return undefined;
  const target = directoryEscalationTarget(resolvedPath);
  if (target === 'other') return undefined;
  if (target === 'missing-directory'
    && (input.deniedPathCreatesDirectory !== true || !input.newFileGrantSupported)) {
    return undefined;
  }
  if (input.policyEnforcer === undefined) return undefined;
  if (writePathPolicyBlocksEscalation(deniedPath, resolvedPath, input.workingDirectory, input.policyEnforcer)) {
    return undefined;
  }
  return resolvedPath;
}

export const SANDBOX_ESCALATION_DECLINED_MESSAGE =
  'The user declined to widen the sandbox for this command. Run it outside the workspace yourself, or ask to change the target path.';

type SandboxEscalationDecision = 'approved' | 'declined';

export interface SandboxEscalationMeta {
  path: string;
  decision: SandboxEscalationDecision;
  /** Card granularity (D4); file cards keep the legacy shape with the field absent. */
  granularity?: 'file' | 'directory';
}
