import type { CreateRunContextInput } from './runContext';
import { isNativeRecoveryDescriptor } from './nativeRecoveryHost';
import { resolveWorkspacePath } from './workspaceScope';
import type { WorkspaceScope } from '../../shared/contract/project';

export interface AdoptedRecoveryWorkspace {
  workspace: string;
  cwd: string;
  workspaceScope?: WorkspaceScope;
}

/**
 * A live continue may come from a process whose orchestrator is still on the
 * default home directory. That cwd is outside the parked run's Project Sources
 * and would throw before the turn resumes. Keep a caller cwd that still fits;
 * otherwise use the workspace frozen on the native checkpoint.
 */
export function resolveAdoptedRecoveryWorkspace(
  input: Pick<CreateRunContextInput, 'workspace' | 'cwd' | 'workspaceScope'>,
  recoveredDescriptor: unknown,
): AdoptedRecoveryWorkspace | null {
  const recovered = isNativeRecoveryDescriptor(recoveredDescriptor)
    ? recoveredDescriptor.workspace
    : undefined;
  const recoveredScope = recovered?.scope;
  const callerCwdFits = !recoveredScope
    || !input.cwd
    || Boolean(resolveWorkspacePath(recoveredScope, input.cwd, 'read'));
  const cwd = (callerCwdFits ? input.cwd : undefined)
    ?? recovered?.cwd
    ?? input.workspace
    ?? recovered?.root;
  const workspace = (callerCwdFits ? input.workspace : undefined)
    ?? recovered?.root
    ?? cwd;
  if (!workspace || !cwd) return null;
  const workspaceScope = input.workspaceScope ?? recoveredScope;
  return {
    workspace,
    cwd,
    ...(workspaceScope ? { workspaceScope } : {}),
  };
}
