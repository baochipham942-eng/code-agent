import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionHistoryAppService } from '../../../src/host/app/sessionHistoryAppService';
import { getAuthService } from '../../../src/host/services/auth/authService';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { getProjectSourceGitStates } from '../../../src/host/services/git/gitStatusService';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { getProjectService } from '../../../src/host/services/project/projectService';
import {
  buildSessionExportEnvelopeV2,
  planSessionForkImport,
  rehashSessionExportEnvelopeV2,
} from '../../../src/host/services/sessionFork/portability';
import type {
  SessionExportEnvelopeV2,
} from '../../../src/shared/contract/sessionForkPortability';
import {
  OWNER_ID,
  PROJECT_ID,
  subtreeDraft,
} from '../services/sessionFork/portability/fixture';

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: vi.fn(),
}));

vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: vi.fn(),
}));

const NAMESPACE = 'device-b';
const REPOSITORY_ROOT = '/workspace/repository';
const WORKSPACE_SCOPE = {
  projectId: PROJECT_ID,
  primaryRoot: REPOSITORY_ROOT,
  roots: [{
    sourceId: 'source-primary',
    path: REPOSITORY_ROOT,
    access: 'read_write' as const,
    role: 'primary' as const,
    identityDev: '1',
    identityIno: '2',
  }],
  version: 'target-scope-v2',
};

function plannedImport(envelope: SessionExportEnvelopeV2) {
  const plan = planSessionForkImport({
    envelope,
    targetOwnerScopeId: OWNER_ID,
    targetProjectId: PROJECT_ID,
    namespace: NAMESPACE,
  });
  return {
    plan,
    result: {
      importId: 'import-1',
      sourceExportId: envelope.exportId,
      rootSessionId: plan.envelope.rootSessionId,
      sessionIdMap: plan.sessionIdMap,
      messageIdMap: plan.messageIdMap,
      forkIdMap: plan.forkIdMap,
      importedAt: 200,
    },
  };
}

function sharedCurrentEnvelope(): SessionExportEnvelopeV2 {
  const draft = subtreeDraft();
  return buildSessionExportEnvelopeV2({
    ...draft,
    sessions: draft.sessions.map((source) => ({
      ...source,
      workspace: {
        mode: 'shared_current' as const,
        label: '历史对话 + 当前文件' as const,
      },
    })),
    lineage: {
      ...draft.lineage,
      nodes: draft.lineage.nodes.map((node) => ({
        ...node,
        workspaceMode: 'shared_current' as const,
      })),
    },
  });
}

function detachedIsolatedEnvelope(): SessionExportEnvelopeV2 {
  const draft = subtreeDraft();
  return buildSessionExportEnvelopeV2({
    ...draft,
    mode: 'detached_child',
    rootSessionId: 'child',
    sessions: [draft.sessions[1]],
    lineage: undefined,
    detachedProvenance: {
      sourceRootSessionId: 'root',
      sourceParentSessionId: 'root',
      sourceForkId: 'fork-1',
      sourceAnchorMessageId: 'a1',
      sourceAnchorDigest: `sha256:${'6'.repeat(64)}`,
      sourceDepth: 1,
    },
  });
}

describe('SessionHistoryAppService imported isolated workspace publication', () => {
  const invalidateSessionCache = vi.fn();
  const database = {
    getProjectRepo: vi.fn(() => ({
      getProject: vi.fn(() => ({ id: PROJECT_ID })),
    })),
    importSessionFork: vi.fn(),
    publishImportedIsolatedWorkspace: vi.fn(),
  };
  const projectService = {
    getWorkspaceScope: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    database.getProjectRepo.mockReturnValue({
      getProject: vi.fn(() => ({ id: PROJECT_ID })),
    });
    vi.mocked(getAuthService).mockReturnValue({
      getCurrentUser: vi.fn(() => ({ id: OWNER_ID })),
    } as never);
    vi.mocked(getDatabase).mockReturnValue(database as never);
    vi.mocked(getSessionManager).mockReturnValue({
      invalidateSessionCache,
    } as never);
    vi.mocked(getProjectService).mockReturnValue(projectService as never);
    projectService.getWorkspaceScope.mockReturnValue(WORKSPACE_SCOPE);
    vi.mocked(getProjectSourceGitStates).mockResolvedValue([{
      sourceId: 'source-primary',
      isRepository: true,
      repositoryRoot: REPOSITORY_ROOT,
      headSha: 'a'.repeat(40),
      branch: 'main',
      dirtyFiles: [],
      ahead: 0,
      behind: 0,
    }]);
  });

  function createService(): SessionHistoryAppService {
    return new SessionHistoryAppService(() => ({}) as never);
  }

  it('publishes an isolated import with the remapped child anchor and verified Project binding', async () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const { plan, result } = plannedImport(envelope);
    database.importSessionFork.mockReturnValue(result);
    database.publishImportedIsolatedWorkspace.mockResolvedValue({
      sessionId: plan.sessionIdMap.child,
      intentId: 'intent-1',
      workspacePath: '/workspace/imported-child',
      evidenceDigest: 'evidence-digest',
      workspaceScopeVersion: WORKSPACE_SCOPE.version,
      publishedAt: 201,
    });

    await expect(createService().importSessionFork({
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    })).resolves.toEqual(result);

    const importedChild = plan.envelope.sessions
      .find((session) => session.id === plan.sessionIdMap.child);
    expect(database.publishImportedIsolatedWorkspace).toHaveBeenCalledWith({
      importedSessionId: plan.sessionIdMap.child,
      importedAnchorMessageId: plan.messageIdMap.ca1,
      ownerUserId: OWNER_ID,
      targetProjectId: PROJECT_ID,
      workspaceBinding: {
        projectId: PROJECT_ID,
        topology: 'single_root_git',
        identityTrust: 'verified',
        repositoryRoot: REPOSITORY_ROOT,
        workspaceScopeVersion: WORKSPACE_SCOPE.version,
      },
      portableEvidence: importedChild?.workspace?.isolatedAnchor,
    });
    expect(database.importSessionFork.mock.invocationCallOrder[0])
      .toBeLessThan(database.publishImportedIsolatedWorkspace.mock.invocationCallOrder[0]);
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.root);
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.child);
  });

  it('keeps an imported isolated session locked when materialization rejects', async () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const { plan, result } = plannedImport(envelope);
    const importedProjection = {
      id: plan.sessionIdMap.child,
      readOnly: true,
      workingDirectory: null,
      workspace: null,
    };
    database.importSessionFork.mockReturnValue(result);
    database.publishImportedIsolatedWorkspace.mockRejectedValue(
      Object.assign(new Error('BASE_COMMIT_UNAVAILABLE: injected materialization failure'), {
        code: 'BASE_COMMIT_UNAVAILABLE',
      }),
    );

    await expect(createService().importSessionFork({
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    })).rejects.toMatchObject({ code: 'BASE_COMMIT_UNAVAILABLE' });

    expect(importedProjection).toEqual({
      id: plan.sessionIdMap.child,
      readOnly: true,
      workingDirectory: null,
      workspace: null,
    });
    expect(database.publishImportedIsolatedWorkspace).toHaveBeenCalledTimes(1);
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.child);
  });

  it('rejects incomplete isolated evidence before the import transaction writes anything', async () => {
    const broken = structuredClone(buildSessionExportEnvelopeV2(subtreeDraft()));
    const isolated = broken.sessions.find((session) => session.id === 'child');
    if (isolated?.workspace) delete isolated.workspace.isolatedAnchor;
    const envelope = rehashSessionExportEnvelopeV2(broken);

    await expect(createService().importSessionFork({
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    })).rejects.toThrow(/PORTABLE_EVIDENCE_REQUIRED/u);

    expect(database.importSessionFork).not.toHaveBeenCalled();
    expect(database.publishImportedIsolatedWorkspace).not.toHaveBeenCalled();
    expect(invalidateSessionCache).not.toHaveBeenCalled();
  });

  it('keeps the imported session locked when the current Project is not single-root', async () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const { plan, result } = plannedImport(envelope);
    database.importSessionFork.mockReturnValue(result);
    projectService.getWorkspaceScope.mockReturnValue({
      ...WORKSPACE_SCOPE,
      roots: [
        ...WORKSPACE_SCOPE.roots,
        {
          sourceId: 'source-secondary',
          path: '/workspace/secondary',
          access: 'read_write',
          role: 'additional',
        },
      ],
    });

    await expect(createService().importSessionFork({
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    })).rejects.toThrow(/one trusted read-write primary Git workspace/u);

    expect(database.importSessionFork).toHaveBeenCalledTimes(1);
    expect(getProjectSourceGitStates).not.toHaveBeenCalled();
    expect(database.publishImportedIsolatedWorkspace).not.toHaveBeenCalled();
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.child);
  });

  it('retries the same imported child after an atomic publication failure', async () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const { plan, result } = plannedImport(envelope);
    const publicationFailure = new Error('injected publication failure');
    database.importSessionFork.mockReturnValue(result);
    database.publishImportedIsolatedWorkspace
      .mockRejectedValueOnce(publicationFailure)
      .mockResolvedValueOnce({
        sessionId: plan.sessionIdMap.child,
        intentId: 'intent-1',
        workspacePath: '/workspace/imported-child',
        evidenceDigest: 'evidence-digest',
        workspaceScopeVersion: WORKSPACE_SCOPE.version,
        publishedAt: 202,
      });
    const service = createService();
    const request = {
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    };

    await expect(service.importSessionFork(request)).rejects.toBe(publicationFailure);
    await expect(service.importSessionFork(request)).resolves.toEqual(result);

    expect(database.importSessionFork).toHaveBeenCalledTimes(2);
    expect(database.publishImportedIsolatedWorkspace).toHaveBeenCalledTimes(2);
    expect(database.publishImportedIsolatedWorkspace.mock.calls[1])
      .toEqual(database.publishImportedIsolatedWorkspace.mock.calls[0]);
    expect(invalidateSessionCache).toHaveBeenCalledTimes(4);
  });

  it('leaves shared-current imports on the existing transaction-only path', async () => {
    const envelope = sharedCurrentEnvelope();
    const { plan, result } = plannedImport(envelope);
    database.importSessionFork.mockReturnValue(result);

    await expect(createService().importSessionFork({
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    })).resolves.toEqual(result);

    expect(getProjectService).not.toHaveBeenCalled();
    expect(getProjectSourceGitStates).not.toHaveBeenCalled();
    expect(database.publishImportedIsolatedWorkspace).not.toHaveBeenCalled();
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.root);
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.child);
  });

  it('does not guess an imported child anchor from detached provenance', async () => {
    const envelope = detachedIsolatedEnvelope();
    const { plan, result } = plannedImport(envelope);
    database.importSessionFork.mockReturnValue(result);

    await expect(createService().importSessionFork({
      envelope,
      targetProjectId: PROJECT_ID,
      namespace: NAMESPACE,
    })).rejects.toThrow(/remapped child anchor/u);

    expect(getProjectService).not.toHaveBeenCalled();
    expect(database.publishImportedIsolatedWorkspace).not.toHaveBeenCalled();
    expect(invalidateSessionCache).toHaveBeenCalledWith(plan.sessionIdMap.child);
  });
});
