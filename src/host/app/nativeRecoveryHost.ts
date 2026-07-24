import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { getDatabase } from '../services/core/databaseService';
import type { NativeRecoveryHostPorts } from '../runtime/nativeRecoveryHost';
import { getProjectService } from '../services/project/projectService';

export function createApplicationNativeRecoveryPorts(): NativeRecoveryHostPorts {
  return {
    continuationExecutor: 'unavailable',
    async resolveWorkspace(descriptor) {
      try {
        const [root, cwd] = await Promise.all([
          realpath(descriptor.workspace.root),
          realpath(descriptor.workspace.cwd),
        ]);
        const fingerprint = createHash('sha256').update(path.resolve(root)).digest('hex');
        return { ok: true, root: path.resolve(root), cwd: path.resolve(cwd), fingerprint };
      } catch {
        return { ok: false, reason: 'native_workspace_unavailable' };
      }
    },
    async resolveWorkspaceScopeVersion(projectId) {
      try {
        return getProjectService().getWorkspaceScope(projectId)?.version ?? null;
      } catch {
        return null;
      }
    },
    model: {
      async dispatchPrepared() {
        throw new Error('native model continuation requires a registered provider recovery executor');
      },
      async queryResult() {
        return null;
      },
      async canRetrySafely() {
        return false;
      },
      async retrySafe() {
        throw new Error('native model safe retry is not proven by the current provider contract');
      },
    },
    tool: {
      async queryResult({ plan, providerOperationId }) {
        const completed = getDatabase().getToolExecutionsBySession(plan.envelope.sessionId, 500)
          .find((event) => event.executionId === providerOperationId
            && event.phase === 'complete'
            && (event.status === 'success' || event.status === 'recovered'));
        return completed ? { resultRef: `tool-ledger:${providerOperationId}` } : null;
      },
    },
    approval: {
      async read(approvalId) {
        const approval = getDatabase().getPendingApprovalRepo().getById(approvalId);
        if (!approval) return 'missing';
        if (approval.status === 'pending') return 'pending';
        if (approval.status === 'approved') return 'approved';
        if (approval.status === 'rejected') return 'rejected';
        return 'conflict';
      },
    },
  };
}
