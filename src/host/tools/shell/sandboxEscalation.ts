import path from 'node:path';
import { homedir } from 'node:os';
import type { OsSandboxDecision, OsSandboxPermissionMode } from '../../sandbox/osSandboxPolicy';
import { resolveCanonicalRunPath } from '../../runtime/runContext';
import { getPolicyEnforcer } from '../../security/policyEnforcer';
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
  /** Command cwd. User path rules compare workspace-relative spellings against it. */
  workingDirectory: string;
}

function writePathPolicyBlocksEscalation(deniedPath: string, workingDirectory: string): boolean {
  let resolvedPath = path.resolve(deniedPath);
  try {
    resolvedPath = resolveCanonicalRunPath(deniedPath);
  } catch {
    // Keep the lexical absolute path and still consult policy below.
  }
  try {
    // The executor already bound this process to the run's policy file.
    // Passing a directory here would retarget that singleton.
    return denyConcreteShellWritePath({
      resolvedPath,
      workingDirectory,
      policyEnforcer: getPolicyEnforcer(),
      pathCandidates: [deniedPath, resolvedPath],
      displayPath: deniedPath,
    }) !== undefined;
  } catch {
    // Unclassifiable paths stay hard-denied. A card would add them to write roots.
    return true;
  }
}

/** Return the one path that may be offered for a single foreground retry. */
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

  const resolvedPath = path.resolve(deniedPath);
  if (resolvedPath === path.parse(resolvedPath).root || resolvedPath === path.resolve(homedir())) {
    return undefined;
  }
  if (writePathPolicyBlocksEscalation(deniedPath, input.workingDirectory)) {
    return undefined;
  }
  return deniedPath;
}

export const SANDBOX_ESCALATION_DECLINED_MESSAGE =
  'The user declined to widen the sandbox for this command. Run it outside the workspace yourself, or ask to change the target path.';

type SandboxEscalationDecision = 'approved' | 'declined';

export interface SandboxEscalationMeta {
  path: string;
  decision: SandboxEscalationDecision;
}
