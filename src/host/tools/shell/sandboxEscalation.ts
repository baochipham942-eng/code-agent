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
  /** The denial came from creating a directory. Directories are never offered. */
  deniedPathCreatesDirectory?: boolean;
  /** The sandbox can allow one file that does not exist yet (seatbelt literal; bubblewrap cannot). */
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

export const SANDBOX_ESCALATION_DECLINED_MESSAGE =
  'The user declined to widen the sandbox for this command. Run it outside the workspace yourself, or ask to change the target path.';

type SandboxEscalationDecision = 'approved' | 'declined';

export interface SandboxEscalationMeta {
  path: string;
  decision: SandboxEscalationDecision;
}
