import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../../src/host/protocol/tools';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  resolveBackgroundWorkspaceAuthority,
  selectBackgroundWorkspaceScope,
} from '../../../../src/host/task/backgroundWorkspaceAuthority';
import { executeDelegateTask } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

function workspaceScope(path: string) {
  return createWorkspaceScope(`project-${path}`, [{
    sourceId: `source-${path}`,
    path,
    role: 'primary',
    access: 'read_write',
  }]);
}

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'workspace-authority-session',
    workingDir: '/tmp/neo-data/work',
    abortSignal: new AbortController().signal,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    emit: vi.fn(),
    ...overrides,
  };
}

const validArgs = {
  title: '修改项目',
  short_name: '改项目',
  lane_key: 'workspace-write',
  submission_key: 'workspace-write-1',
  prompt: '修改 package.json',
};

const allow = vi.fn().mockResolvedValue({ allow: true }) as CanUseToolFn;

describe('delegate_task workspace authority', () => {
  afterEach(() => {
    resetSessionCommandCenterForTest();
    vi.clearAllMocks();
  });

  it('keeps the foreground turn project scope authoritative over the child session fallback', () => {
    const foreground = workspaceScope('/tmp/user-project');
    const childFallback = workspaceScope('/tmp/neo-data/work');

    expect(selectBackgroundWorkspaceScope(foreground, childFallback)).toBe(foreground);
    expect(selectBackgroundWorkspaceScope(foreground, childFallback)?.primaryRoot)
      .toBe(foreground.primaryRoot);
  });

  it('passes the foreground scope snapshot from delegate_task into SessionCommandCenter', async () => {
    const foreground = workspaceScope('/tmp/user-project');
    const sessionId = 'workspace-authority-forwarding';

    const result = await executeDelegateTask(
      validArgs,
      toolContext({
        sessionId,
        workspace: foreground.primaryRoot,
        workspaceScope: foreground,
      }),
      allow,
    );

    expect(result).toMatchObject({ ok: true });
    expect(getSessionCommandCenter().list(sessionId)).toEqual([
      expect.objectContaining({
        workspaceScope: foreground,
      }),
    ]);
  });

  it('does not turn the user home working directory into a workspace boundary', () => {
    const home = '/tmp/test-home';

    expect(resolveBackgroundWorkspaceAuthority(
      { workspace: home, workspaceScope: workspaceScope(home) },
      { homeDirectories: [home], dataDirectory: `${home}/.code-agent` },
    )).toBeUndefined();
  });

  it('does not turn the product data work directory into a workspace boundary', () => {
    const home = '/tmp/test-home';
    const dataWork = `${home}/.code-agent-dev/work`;

    expect(resolveBackgroundWorkspaceAuthority(
      { workspace: dataWork, workspaceScope: workspaceScope(dataWork) },
      { homeDirectories: [home], dataDirectory: `${home}/.code-agent-dev` },
    )).toBeUndefined();
  });

  it('returns WORKSPACE_REQUIRED before SessionCommandCenter creates a task', async () => {
    const sessionId = 'workspace-required-session';
    const result = await executeDelegateTask(
      validArgs,
      toolContext({ sessionId }),
      allow,
    );

    expect(getSessionCommandCenter().list(sessionId)).toEqual([]);
    expect(result).toEqual({
      ok: false,
      error: '没有可写的项目根，请先选择项目或添加目录。',
      code: 'WORKSPACE_REQUIRED',
    });
  });
});
