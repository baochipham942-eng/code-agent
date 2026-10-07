import type { PortableIsolatedAnchorEvidenceV1 } from '../../../../shared/contract/sessionForkPortability';
import { NodeWorkspaceCommandRunner } from './commandRunner';
import { ImportedPortableAnchorWorkspaceMaterializer } from './importedPortableAnchorWorkspaceMaterializer';
import {
  CONFLICT_OPTIONS,
  PortableEvidenceApplyBackEngine,
  type PortableEvidenceApplyBackFileReport,
  type PortableEvidenceClassification,
  type PortableEvidenceConflictOption,
} from './portableEvidenceApplyBackEngine';
import {
  buildPortableEvidenceWorkItems,
  type PortableEvidenceWorkItem,
} from './portableEvidenceWorkItems';
import type { AnchorWorkspaceEvidence, WorkspaceCommandRunner } from './types';

interface PortableEvidenceApplyBackResult {
  mode: 'dry-run' | 'apply';
  outcome: 'success' | 'partial' | 'failed';
  workspaceRoot: string;
  baseCommit: string;
  files: PortableEvidenceApplyBackFileReport[];
  wouldChange: string[];
  conflicts: string[];
  error?: string;
  rollbackVerified?: boolean;
}

type ApplyBackErrorCode = 'EVIDENCE_BINDING_REJECTED' | 'UNSAFE_EVIDENCE_PATH' | 'INVALID_RESOLUTION';

class PortableEvidenceApplyBackError extends Error {
  constructor(
    readonly code: ApplyBackErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PortableEvidenceApplyBackError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reuses the materializer's trusted-binding validation: identity, base commit and digests. */
async function rebindPortableEvidence(
  evidence: PortableIsolatedAnchorEvidenceV1,
  workspaceRoot: string,
  runner: WorkspaceCommandRunner,
): Promise<{ repositoryRoot: string; evidence: AnchorWorkspaceEvidence }> {
  const materializer = new ImportedPortableAnchorWorkspaceMaterializer({
    workspaceService: {
      prepare: async () => {
        throw new Error('apply-back never prepares an isolated workspace');
      },
    },
    runner,
  });
  return await materializer.rebindEvidence({
    portableEvidence: evidence,
    targetProjectId: 'portable-evidence-apply-back',
    workspaceBinding: {
      projectId: 'portable-evidence-apply-back',
      topology: 'single_root_git',
      identityTrust: 'verified',
      repositoryRoot: workspaceRoot,
      workspaceScopeVersion: evidence.workspaceScopeVersion,
    },
    intentId: 'portable-evidence-apply-back',
    sourceSessionId: 'portable-evidence-apply-back',
    proposedChildSessionId: 'portable-evidence-apply-back',
    destinationName: 'portable-evidence-apply-back',
  });
}

function validateResolutions(
  mode: 'dry-run' | 'apply',
  resolutions: Record<string, PortableEvidenceConflictOption> | undefined,
  knownPaths: Set<string>,
): void {
  if (!resolutions) return;
  if (mode !== 'apply') {
    throw new PortableEvidenceApplyBackError(
      'INVALID_RESOLUTION',
      'resolutions are only honoured in apply mode; re-run the dry-run without them',
    );
  }
  for (const [target, choice] of Object.entries(resolutions)) {
    if (!CONFLICT_OPTIONS.includes(choice)) {
      throw new PortableEvidenceApplyBackError(
        'INVALID_RESOLUTION',
        `unknown conflict resolution ${JSON.stringify(String(choice))} for ${target}`,
      );
    }
    if (!knownPaths.has(target)) {
      throw new PortableEvidenceApplyBackError(
        'INVALID_RESOLUTION',
        `resolution targets a path that is not part of the portable evidence: ${target}`,
      );
    }
  }
}

export async function applyPortableEvidenceToWorkspace(
  input: {
    evidence: PortableIsolatedAnchorEvidenceV1;
    workspaceRoot: string;
    mode: 'dry-run' | 'apply';
    resolutions?: Record<string, PortableEvidenceConflictOption>;
  },
  options?: { runner?: WorkspaceCommandRunner },
): Promise<PortableEvidenceApplyBackResult> {
  const runner = options?.runner ?? new NodeWorkspaceCommandRunner();
  const rebound = await rebindPortableEvidence(input.evidence, input.workspaceRoot, runner).catch(
    (error: unknown) => {
      throw new PortableEvidenceApplyBackError(
        'EVIDENCE_BINDING_REJECTED',
        `portable evidence was not accepted for this workspace: ${errorMessage(error)}`,
        error,
      );
    },
  );
  const engine = new PortableEvidenceApplyBackEngine(runner, rebound.repositoryRoot, input.evidence.baseCommit);
  const { items, invalid, unsafe } = buildPortableEvidenceWorkItems(rebound.evidence);
  if (unsafe.length > 0) {
    // A path outside the safety envelope means hostile or corrupt evidence:
    // nothing is applied, not even the clean items, in either mode.
    throw new PortableEvidenceApplyBackError(
      'UNSAFE_EVIDENCE_PATH',
      `evidence names ${unsafe.length} path(s) outside the repository safety envelope `
        + `(${unsafe.map((entry) => entry.label).join(', ')}); rejecting without applying anything`,
    );
  }
  validateResolutions(input.mode, input.resolutions, new Set(items.map((item) => item.path)));
  const invalidReports: PortableEvidenceApplyBackFileReport[] = invalid.map((entry) => ({
    path: entry.label,
    source: entry.source,
    status: 'conflict',
    reason: entry.reason,
    options: CONFLICT_OPTIONS,
  }));
  const plans: Array<{ item: PortableEvidenceWorkItem; classification: PortableEvidenceClassification }> = [];
  for (const item of items) plans.push({ item, classification: await classify(engine, item) });

  if (input.mode === 'dry-run') {
    const files: PortableEvidenceApplyBackFileReport[] = [
      ...invalidReports,
      ...plans.map(({ item, classification }) => ({
        path: item.path,
        source: item.source,
        status: classification.status,
        ...(classification.reason ? { reason: classification.reason } : {}),
        ...(classification.status === 'conflict' ? { options: CONFLICT_OPTIONS } : {}),
      })),
    ];
    const conflicts = files.filter((file) => file.status === 'conflict').map((file) => file.path);
    return {
      mode: 'dry-run',
      outcome: conflicts.length > 0 ? 'partial' : 'success',
      workspaceRoot: rebound.repositoryRoot,
      baseCommit: input.evidence.baseCommit,
      files,
      wouldChange: [
        ...new Set(plans
          .filter((plan) => plan.classification.status === 'would-apply')
          .flatMap((plan) => itemChangePaths(plan.item))),
      ],
      conflicts,
    };
  }

  const statusBefore = await engine.treeStatusSnapshot();
  const files: PortableEvidenceApplyBackFileReport[] = [...invalidReports];
  const changedPaths: string[] = [];
  try {
    for (const { item, classification } of plans) {
      if (classification.status === 'would-apply') {
        if (item.kind === 'patch') {
          for (const section of item.sections) await engine.applyPatchSection(section);
        } else {
          await engine.applyUntrackedItem(item);
        }
        changedPaths.push(...itemChangePaths(item));
        files.push({ path: item.path, source: item.source, status: 'applied' });
      } else if (classification.status === 'already-present') {
        files.push({ path: item.path, source: item.source, status: 'already-present' });
      } else {
        const resolved = await engine.resolveConflict(item, classification, input.resolutions?.[item.path]);
        // took-cloud rebuilds and consumes the rename pre-image; save-as leaves
        // it rolled back, so only the sidecar (reported under the item path) changed.
        if (resolved.status === 'took-cloud') changedPaths.push(...itemChangePaths(item));
        else if (resolved.status === 'saved-as-cloud') changedPaths.push(item.path);
        files.push(resolved);
      }
    }
  } catch (error) {
    let rollbackVerified = false;
    let rollbackNote = '';
    try {
      await engine.rollback();
      rollbackVerified = (await engine.treeStatusSnapshot()) === statusBefore;
    } catch (rollbackError) {
      rollbackNote = `; rollback itself failed: ${errorMessage(rollbackError)}`;
    }
    return {
      mode: 'apply',
      outcome: 'failed',
      workspaceRoot: rebound.repositoryRoot,
      baseCommit: input.evidence.baseCommit,
      files: [],
      wouldChange: [],
      conflicts: [],
      error: `${errorMessage(error)}${rollbackNote}`,
      rollbackVerified,
    };
  }
  const conflicts = files.filter((file) => file.status === 'conflict').map((file) => file.path);
  return {
    mode: 'apply',
    outcome: conflicts.length > 0 ? 'partial' : 'success',
    workspaceRoot: rebound.repositoryRoot,
    baseCommit: input.evidence.baseCommit,
    files,
    wouldChange: [...new Set(changedPaths)],
    conflicts,
  };
}

/** An apply of a patch item also restores/consumes its rename pre-image paths. */
function itemChangePaths(item: PortableEvidenceWorkItem): string[] {
  return item.kind === 'patch' ? [item.path, ...item.preimagePaths] : [item.path];
}

function classify(
  engine: PortableEvidenceApplyBackEngine,
  item: PortableEvidenceWorkItem,
): Promise<PortableEvidenceClassification> {
  return item.kind === 'patch'
    ? engine.checkPatchItem(item)
    : engine.checkUntrackedItem(item);
}
