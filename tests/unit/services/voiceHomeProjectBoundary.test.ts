import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Project, ProjectSource } from '../../../src/shared/contract/project';
import { workspacePathIdentity } from '../../../src/host/runtime/workspaceScope';

const state = vi.hoisted(() => ({
  projects: new Map<string, Project>(),
  sources: [] as ProjectSource[],
  sessions: [] as Array<Record<string, unknown>>,
}));

const projectRepo = {
  getProject: (id: string) => state.projects.get(id),
  getProjectByWorkspaceKey: (key: string) => Array.from(state.projects.values())
    .find((project) => project.workspaceKey === key),
  upsertProject: (project: Project) => { state.projects.set(project.id, project); },
  upsertSource: (source: ProjectSource) => { state.sources.push(source); },
  listSources: (projectId: string) => state.sources.filter((source) => source.projectId === projectId),
  backfillProjectSources: () => 0,
  listGoals: () => [],
  listRoles: () => [],
  listSessionIds: () => [],
};

const database = {
  getProjectRepo: () => projectRepo,
  createSession: (session: Record<string, unknown>) => { state.sessions.push(session); },
  getSession: (sessionId: string) => state.sessions.find((session) => session.id === sessionId) ?? null,
  getDb: () => undefined,
  logAuditEvent: vi.fn(),
};

vi.mock('../../../src/host/services/core', () => ({ getDatabase: () => database }));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => database }));
vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  linkProjectIdToMeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/host/platform', () => ({ AppWindow: { getAllWindows: () => [] } }));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../src/host/services/permissions/modes', () => ({
  getPermissionModeManager: () => ({ initSessionMode: vi.fn(), markUnattendedSession: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

import { SessionManager } from '../../../src/host/services/infra/sessionManager';
import { getProjectService } from '../../../src/host/services/project/projectService';
import { resolveToolPermissionClassification } from '../../../src/host/tools/toolPermissionClassification';

describe('语音后台任务的 HOME 项目自动注册边界', () => {
  let fakeHome: string;
  let previousCodeAgentHome: string | undefined;

  afterEach(async () => {
    state.projects.clear();
    state.sources.splice(0);
    state.sessions.splice(0);
    if (previousCodeAgentHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = previousCodeAgentHome;
    if (fakeHome) await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('会话创建不得把 HOME 自动注册为 trusted primary，HOME 写入必须落审批（真机根因形状）', async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-home-project-boundary-'));
    previousCodeAgentHome = process.env.CODE_AGENT_HOME;
    process.env.CODE_AGENT_HOME = fakeHome;

    const session = await new SessionManager().createSession({
      title: 'voice home boundary',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: fakeHome,
    });
    const scope = getProjectService().getWorkspaceScope(session.projectId!);
    const workspaceRoot = scope?.primaryRoot;
    const classification = await resolveToolPermissionClassification({
      executionToolName: 'Write',
      policyToolName: 'Write',
      params: { file_path: path.join(fakeHome, 'boundary-probe.txt'), content: 'x' },
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: fakeHome,
      workspaceRoot,
      permissionLevel: 'write',
      permStartTime: Date.now(),
      readOnlyForcesConfirmation: false,
      sessionPermissionMode: 'default',
    });

    // 红测曾在这里观测到：workspaceRoot=fakeHome、classification=approve。修复后两者必须同时收紧。
    expect(workspaceRoot).toBeUndefined();
    expect(classification.decision).toBe('ask');
  });

  it('会话创建仍会把具体项目目录注册为 trusted primary，并保持项目内写入 approve', async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-project-boundary-positive-'));

    const session = await new SessionManager().createSession({
      title: 'voice project boundary positive',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: fakeHome,
    });
    const scope = getProjectService().getWorkspaceScope(session.projectId!);
    const workspaceRoot = scope?.primaryRoot;
    const classification = await resolveToolPermissionClassification({
      executionToolName: 'Write',
      policyToolName: 'Write',
      params: { file_path: path.join(fakeHome, 'boundary-probe.txt'), content: 'x' },
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: fakeHome,
      workspaceRoot,
      permissionLevel: 'write',
      permStartTime: Date.now(),
      readOnlyForcesConfirmation: false,
      sessionPermissionMode: 'default',
    });

    expect(workspaceRoot).toBe(await fs.realpath(fakeHome));
    expect(classification.decision).toBe('approve');
  });

  it('存量 HOME project 即使仍是 trusted primary，也不能再派生写入 scope', async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-home-project-legacy-'));
    previousCodeAgentHome = process.env.CODE_AGENT_HOME;
    process.env.CODE_AGENT_HOME = fakeHome;
    const canonicalHome = await fs.realpath(fakeHome);
    const identity = workspacePathIdentity(canonicalHome);
    const projectId = 'proj_legacy_home';
    state.projects.set(projectId, {
      id: projectId,
      name: 'legacy-home',
      workspacePath: fakeHome,
      workspaceKey: 'legacy-home-key',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      sourceRevision: 0,
    });
    state.sources.push({
      id: 'psrc_legacy_home',
      projectId,
      path: fakeHome,
      canonicalPath: canonicalHome,
      role: 'primary',
      access: 'read_write',
      trustState: 'trusted',
      identityDev: identity.dev,
      identityIno: identity.ino,
      createdAt: 1,
      updatedAt: 1,
    });

    const scope = getProjectService().getWorkspaceScope(projectId);
    const classification = await resolveToolPermissionClassification({
      executionToolName: 'Write',
      policyToolName: 'Write',
      params: { file_path: path.join(fakeHome, 'boundary-probe.txt'), content: 'x' },
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: fakeHome,
      workspaceRoot: scope?.primaryRoot,
      permissionLevel: 'write',
      permStartTime: Date.now(),
      readOnlyForcesConfirmation: false,
      sessionPermissionMode: 'default',
    });

    expect(scope).toBeUndefined();
    expect(classification.decision).toBe('ask');
  });

  it('显式创建 Project 或 Project Space 时也拒绝 HOME，不把用户选择变成写边界', async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-home-project-explicit-'));
    previousCodeAgentHome = process.env.CODE_AGENT_HOME;
    process.env.CODE_AGENT_HOME = fakeHome;

    await expect(getProjectService().createProject({ name: 'home project', workspacePath: fakeHome }, 1))
      .rejects.toThrow('Unsafe workspace path');
    await expect(getProjectService().createSpace({ name: 'home space', workspacePath: fakeHome }, 1))
      .rejects.toThrow('Unsafe workspace path');
    expect(state.projects.size).toBe(0);
    expect(state.sources).toHaveLength(0);
  });
});
