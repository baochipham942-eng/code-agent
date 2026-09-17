import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentDurableRouteRunLifecycle,
  resolveNativeRunWorkspaceScope,
} from '../../../src/web/routes/agentDurableRouteLifecycle';
import { createRunContext, createRunHandle } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { WorkspaceScope } from '../../../src/shared/contract/project';
import type { CreateRunContextInput, RunHandle } from '../../../src/host/runtime/runContext';
import type { RunRegistry } from '../../../src/host/runtime/runRegistry';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function projectScope(primaryRoot: string, projectId = 'project-native'): WorkspaceScope {
  return createWorkspaceScope(projectId, [{
    sourceId: 'source-primary',
    path: primaryRoot,
    role: 'primary',
    access: 'read_write',
  }]);
}

function fakeRegistry(startDurable: (input: CreateRunContextInput) => Promise<RunHandle> | RunHandle) {
  const stub = vi.fn(startDurable);
  return {
    registry: { startDurable: stub, start: vi.fn() } as unknown as RunRegistry,
    startDurable: stub,
  };
}

describe('resolveNativeRunWorkspaceScope', () => {
  it('binds a real Project scope whose workspace stays inside the boundary', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-bind-')));
    try {
      const scope = projectScope(workspace);
      expect(resolveNativeRunWorkspaceScope({ sessionScope: scope, workspace })).toBe(scope);
      expect(resolveNativeRunWorkspaceScope({
        sessionScope: scope,
        workspace: path.join(workspace, 'nested'),
      })).toBe(scope);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the legacy fallback for isolated Fork scopes', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-isolated-')));
    try {
      const isolated = {
        ...projectScope(workspace),
        version: `isolated-v1:intent:evidence`,
      };
      expect(resolveNativeRunWorkspaceScope({ sessionScope: isolated, workspace })).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the legacy fallback when the session workspace left the Project boundary', () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-outside-')));
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-elsewhere-')));
    try {
      const scope = projectScope(workspace);
      expect(resolveNativeRunWorkspaceScope({ sessionScope: scope, workspace: elsewhere }))
        .toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('returns undefined when the session has no scope at all', () => {
    expect(resolveNativeRunWorkspaceScope({ sessionScope: undefined, workspace: '/repo' }))
      .toBeUndefined();
  });
});

describe('AgentDurableRouteRunLifecycle durable start', () => {
  it('passes the Project scope through so the run carries the real projectId', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-run-')));
    try {
      const scope = projectScope(workspace, 'project-from-session');
      const { registry, startDurable } = fakeRegistry((input) => (
        createRunHandle(createRunContext(input))
      ));

      const lifecycle = createAgentDurableRouteRunLifecycle({
        runRegistry: registry,
        sessionId: 'session-project',
        workspace,
        workspaceScope: scope,
        durableActivation: true,
        logger,
      });
      const { runHandle } = await lifecycle.start();

      expect(startDurable).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-project',
        workspace,
        workspaceScope: scope,
        cwd: workspace,
      }));
      expect(runHandle.context.workspaceScope?.projectId).toBe('project-from-session');
      expect(runHandle.context.cwd).toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('widens a sub-folder session to the Project root while keeping cwd on the session folder', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-scope-nested-')));
    const nested = path.join(workspace, 'pkg');
    mkdirSync(nested);
    try {
      const scope = projectScope(workspace, 'project-nested');
      const { registry } = fakeRegistry((input) => createRunHandle(createRunContext(input)));
      const { runHandle } = await createAgentDurableRouteRunLifecycle({
        runRegistry: registry,
        sessionId: 'session-nested',
        workspace: nested,
        workspaceScope: resolveNativeRunWorkspaceScope({ sessionScope: scope, workspace: nested }),
        durableActivation: true,
        logger,
      }).start();

      // 与 orchestrator 路径一致：run 的 workspace（工具缓存 / 账本 / policy 根）取 Project 根，
      // 相对路径与进程目录仍落在会话文件夹。
      expect(runHandle.context.workspace).toBe(workspace);
      expect(runHandle.context.cwd).toBe(nested);
      expect(runHandle.context.workspaceScope?.projectId).toBe('project-nested');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('starts without a scope (legacy fallback) when none is bindable', async () => {
    const { registry, startDurable } = fakeRegistry((input) => (
      createRunHandle(createRunContext(input))
    ));

    const lifecycle = createAgentDurableRouteRunLifecycle({
      runRegistry: registry,
      sessionId: 'session-legacy',
      workspace: realpathSync(tmpdir()),
      durableActivation: true,
      logger,
    });
    await lifecycle.start();

    const input = startDurable.mock.calls[0][0];
    expect(input.workspaceScope).toBeUndefined();
    // cwd 钉在会话工作目录上，不带 scope 时行为与旧路径一致。
    expect(input.cwd).toBe(input.workspace);
  });
});
