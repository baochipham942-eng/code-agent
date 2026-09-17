import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationNativeRecoveryPorts } from '../../../../src/host/app/nativeRecoveryHost';
import {
  resolveBackgroundWorkspaceAuthority,
} from '../../../../src/host/runtime/workspaceAuthority';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import type { WorkspaceScope } from '../../../../src/shared/contract/project';

const projectServiceMocks = vi.hoisted(() => ({
  getWorkspaceScope: vi.fn(),
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ getWorkspaceScope: projectServiceMocks.getWorkspaceScope }),
}));

function legacyScope(root: string): WorkspaceScope {
  const scope = resolveBackgroundWorkspaceAuthority({ workspace: root });
  if (!scope) throw new Error(`expected a legacy authority scope for ${root}`);
  return scope;
}

// 合成 scope id 不导出（生产无外部消费方）；测试按字面钉住它。
const LEGACY_BACKGROUND_AUTHORITY_PROJECT_ID = 'legacy-background-authority';

describe('application native recovery workspace scope version', () => {
  it('recomputes a legacy synthetic scope from its primaryRoot instead of the Project library', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'legacy-scope-recovery-')));
    try {
      const scope = legacyScope(workspace);
      expect(scope.projectId).toBe(LEGACY_BACKGROUND_AUTHORITY_PROJECT_ID);

      await expect(
        createApplicationNativeRecoveryPorts().resolveWorkspaceScopeVersion!(scope),
      ).resolves.toBe(scope.version);
      // 合成 id 永远不进项目库：查库路径必须被完全短路。
      expect(projectServiceMocks.getWorkspaceScope).not.toHaveBeenCalled();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('still flags drift when a legacy primaryRoot is no longer a safe authority root', async () => {
    // $HOME 本身永远当不成写边界：同一条重算路径在建 run 时就不会给它铸 scope，
    // 恢复时重算必须同样拒绝（返回 null → 上层判 native_workspace_scope_drift）。
    const scope = createWorkspaceScope(LEGACY_BACKGROUND_AUTHORITY_PROJECT_ID, [{
      sourceId: 'legacy-background-primary',
      path: homedir(),
      role: 'primary',
      access: 'read_write',
    }]);

    await expect(
      createApplicationNativeRecoveryPorts().resolveWorkspaceScopeVersion!(scope),
    ).resolves.toBeNull();
  });

  it('keeps deriving real Project scopes from the Project library', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'project-scope-recovery-')));
    try {
      const scope = createWorkspaceScope('project-real', [{
        sourceId: 'source-primary',
        path: workspace,
        role: 'primary',
        access: 'read_write',
      }]);
      projectServiceMocks.getWorkspaceScope.mockReturnValue(scope);

      await expect(
        createApplicationNativeRecoveryPorts().resolveWorkspaceScopeVersion!(scope),
      ).resolves.toBe(scope.version);
      expect(projectServiceMocks.getWorkspaceScope).toHaveBeenCalledWith('project-real');
    } finally {
      projectServiceMocks.getWorkspaceScope.mockReset();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns null when the Project behind a real scope no longer resolves one', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'project-scope-deleted-')));
    try {
      const scope = createWorkspaceScope('project-deleted', [{
        sourceId: 'source-primary',
        path: workspace,
        role: 'primary',
        access: 'read_write',
      }]);
      projectServiceMocks.getWorkspaceScope.mockReturnValue(undefined);

      await expect(
        createApplicationNativeRecoveryPorts().resolveWorkspaceScopeVersion!(scope),
      ).resolves.toBeNull();
    } finally {
      projectServiceMocks.getWorkspaceScope.mockReset();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
