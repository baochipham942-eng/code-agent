import os from 'node:os';
import path from 'node:path';
import { createRunContext } from '../../../../src/host/runtime/runContext';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../../src/host/protocol/tools';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  resolveBackgroundWorkspaceAuthority,
  selectBackgroundWorkspaceScope,
} from '../../../../src/host/runtime/workspaceAuthority';
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

  // 对抗审查实测出来的绕过：只查「root 在敏感目录里面」，不查「root 包含敏感目录」。
  // $HOME 本身被挡住，但它的父目录和文件系统根都被 ACCEPTED——一旦成为 workspace，
  // $HOME/.code-agent 又落回「项目目录内」，W1 照常自动放行，整条拒绝清单被祖先路径绕开。
  it('does not accept an ancestor of the home or data directory as a workspace boundary', () => {
    const home = '/tmp/test-home';
    const dirs = { homeDirectories: [home], dataDirectory: `${home}/.code-agent` };

    for (const ancestor of ['/tmp', '/']) {
      expect(
        resolveBackgroundWorkspaceAuthority(
          { workspace: ancestor, workspaceScope: workspaceScope(ancestor) },
          dirs,
        ),
        `${ancestor} 不该成为可写边界`,
      ).toBeUndefined();
    }

    // 兄弟目录不含敏感目录，仍然应当放行——别把拒绝面扩大成「凡是短路径都拒」
    expect(resolveBackgroundWorkspaceAuthority(
      { workspace: '/tmp/some-project', workspaceScope: workspaceScope('/tmp/some-project') },
      dirs,
    )).toBeDefined();
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

// ============================================================================
// 丙案（产品负责人 2026-08-08 拍板）：cwd 仍是写边界的合法来源，但必须过宽度校验。
//
// 依据①竞品一致：Claude Code 继承父会话 cwd、Codex CLI 用启动 cwd + writable_roots、
// Aider 用 cwd 所在 git 仓根、Cline/Zed 用打开的文件夹——没有一家要求先注册「项目」。
// 依据②真库切窗：无 project_id 的 1933 个会话里，working_directory 是「具体目录」的有
// 1914 个、HOME 本身 1 个、无目录 18 个。判「无 scope 就无写边界」会误伤那 1914 个。
//
// 这一组钉的是 createRunContext 这一层：没有显式 workspaceScope 时，
// 校验通过的 cwd 要成为写边界，校验不过的必须落空（下游 classifier 判 W3 ask）。
// ============================================================================
describe('createRunContext 的 cwd 兜底必须过宽度校验', () => {
  const base = { runId: 'run-cwd-boundary', sessionId: 'session-cwd-boundary' };

  it('具体项目目录：成为写边界（这是 1914 个会话不受影响的保证）', () => {
    const run = createRunContext({ ...base, workspace: '/tmp/neo-real-project' });
    // 断言锚「边界建起来了、且就是这个目录」，不锚字面量——macOS 上 /tmp 是
    // /private/tmp 的符号链接，runContext 刻意做规范化（防 symlink 被中途改指向）。
    expect(run.workspaceScope).toBeDefined();
    expect(run.workspaceScope?.primaryRoot).toBe(run.workspace);
    expect(run.workspaceScope?.primaryRoot.endsWith('/neo-real-project')).toBe(true);
  });

  it('$HOME 本身：不得成为写边界', () => {
    const run = createRunContext({ ...base, workspace: os.homedir() });
    expect(run.workspaceScope).toBeUndefined();
  });

  it('产品数据目录：不得成为写边界', () => {
    const run = createRunContext({ ...base, workspace: path.join(os.homedir(), '.code-agent', 'work') });
    expect(run.workspaceScope).toBeUndefined();
  });

  it('敏感目录的祖先：不得成为写边界', () => {
    const run = createRunContext({ ...base, workspace: path.dirname(os.homedir()) });
    expect(run.workspaceScope).toBeUndefined();
  });

  it('校验不过时 run 仍然起得来（不许打死只读后台任务）', () => {
    const run = createRunContext({ ...base, workspace: os.homedir() });
    expect(run.runId).toBe(base.runId);
    expect(run.cwd).toBeTruthy();
  });
});
