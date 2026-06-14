import { describe, expect, it } from 'vitest';
import {
  getSidebarGroupKeyForSession,
  groupByWorkspace,
  isWorkspaceExpanded,
  UNCATEGORIZED_WORKSPACE_KEY,
} from '../../../src/renderer/utils/workspaceGrouping';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

type SessionOverrides = {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  workingDirectory?: string;
  messageCount?: number;
  turnCount?: number;
  projectId?: string;
};

function makeSession(overrides: SessionOverrides = {}): SessionWithMeta {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    title: overrides.title ?? 'Untitled',
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    modelConfig: { provider: 'test' as any, model: 'test' },
    messageCount: overrides.messageCount ?? 0,
    turnCount: overrides.turnCount ?? 0,
    ...overrides,
  } as SessionWithMeta;
}

describe('groupByWorkspace', () => {
  it('buckets sessions without project metadata by full workingDirectory path, using basename for display', () => {
    const sessions = [
      makeSession({ id: 's1', workingDirectory: '/Users/me/Downloads/ai/code-agent', updatedAt: 100 }),
      makeSession({ id: 's2', workingDirectory: '/Users/me/Downloads/ai/code-agent', updatedAt: 200 }),
      makeSession({ id: 's3', workingDirectory: '/Users/me/Downloads', updatedAt: 150 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(2);
    const codeAgent = groups.find((g) => g.name === 'code-agent')!;
    const downloads = groups.find((g) => g.name === 'Downloads')!;
    expect(codeAgent.path).toBe('/Users/me/Downloads/ai/code-agent');
    expect(codeAgent.paths).toEqual(['/Users/me/Downloads/ai/code-agent']);
    expect(codeAgent.sessions.map((s) => s.id)).toEqual(['s2', 's1']); // LRU
    expect(downloads.sessions.map((s) => s.id)).toEqual(['s3']);
  });

  it('keeps workspaces with the same basename but different parents separate', () => {
    const sessions = [
      makeSession({ id: 'a', workingDirectory: '/work/alpha/foo', updatedAt: 100 }),
      makeSession({ id: 'b', workingDirectory: '/work/beta/foo', updatedAt: 200 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe('foo');
    expect(groups[1].name).toBe('foo');
    expect(groups[0].path).not.toBe(groups[1].path);
    expect(groups[0].key).not.toBe(groups[1].key);
  });

  it('orders categorized groups by latest activity, most recent first', () => {
    const sessions = [
      makeSession({ id: 'old', workingDirectory: '/old-proj', updatedAt: 100 }),
      makeSession({ id: 'new', workingDirectory: '/new-proj', updatedAt: 300 }),
      makeSession({ id: 'mid', workingDirectory: '/mid-proj', updatedAt: 200 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups.map((g) => g.name)).toEqual(['new-proj', 'mid-proj', 'old-proj']);
  });

  it("puts sessions without workingDirectory into an uncategorized bucket at the end", () => {
    const sessions = [
      makeSession({ id: 'chat1', workingDirectory: undefined, updatedAt: 500 }),
      makeSession({ id: 'proj1', workingDirectory: '/some-proj', updatedAt: 100 }),
      makeSession({ id: 'chat2', workingDirectory: '', updatedAt: 400 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(2);
    expect(groups[0].isUncategorized).toBe(false);
    expect(groups[0].name).toBe('some-proj');
    expect(groups[1].isUncategorized).toBe(true);
    expect(groups[1].key).toBe(UNCATEGORIZED_WORKSPACE_KEY);
    expect(groups[1].name).toBe('未分类');
    expect(groups[1].paths).toEqual([]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['chat1', 'chat2']);
  });

  it('even with zero recent activity, the uncategorized bucket stays pinned to the bottom', () => {
    const sessions = [
      makeSession({ id: 'chat-ancient', workingDirectory: undefined, updatedAt: 1 }),
      makeSession({ id: 'proj-old', workingDirectory: '/old', updatedAt: 100 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups[groups.length - 1].isUncategorized).toBe(true);
  });

  it('trims trailing slashes from workspace paths before extracting basename', () => {
    const sessions = [
      makeSession({ id: 's', workingDirectory: '/Users/me/projects/foo/', updatedAt: 0 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups[0].name).toBe('foo');
  });

  it('returns empty array for empty input', () => {
    expect(groupByWorkspace([])).toEqual([]);
  });

  it('surfaces a shared project id when every session in a workspace agrees', () => {
    const sessions = [
      makeSession({ id: 'a', workingDirectory: '/repo/code-agent', projectId: 'proj-code-agent' }),
      makeSession({ id: 'b', workingDirectory: '/repo/code-agent', projectId: 'proj-code-agent' }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups[0].projectId).toBe('proj-code-agent');
    expect(groups[0].key).toBe('project:proj-code-agent');
  });

  it('groups sessions by project id before workspace path', () => {
    const sessions = [
      makeSession({ id: 'main', workingDirectory: '/repo/code-agent', projectId: 'proj-code-agent', updatedAt: 100 }),
      makeSession({ id: 'worktree', workingDirectory: '/repo/code-agent-worktree', projectId: 'proj-code-agent', updatedAt: 300 }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('project:proj-code-agent');
    expect(groups[0].projectId).toBe('proj-code-agent');
    expect(groups[0].path).toBe('/repo/code-agent-worktree');
    expect(groups[0].paths).toEqual(['/repo/code-agent-worktree', '/repo/code-agent']);
    expect(groups[0].sessions.map((session) => session.id)).toEqual(['worktree', 'main']);
  });

  it('separates sessions with different project ids even when workspace path matches', () => {
    const sessions = [
      makeSession({ id: 'a', workingDirectory: '/repo/code-agent', projectId: 'proj-a' }),
      makeSession({ id: 'b', workingDirectory: '/repo/code-agent', projectId: 'proj-b' }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.projectId).sort()).toEqual(['proj-a', 'proj-b']);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });

  it('keeps project-backed and workspace-only sessions in separate groups', () => {
    const sessions = [
      makeSession({ id: 'a', workingDirectory: '/repo/code-agent', projectId: 'proj-code-agent' }),
      makeSession({ id: 'b', workingDirectory: '/repo/code-agent' }),
    ];

    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.projectId === 'proj-code-agent')?.key).toBe('project:proj-code-agent');
    expect(groups.find((group) => !group.projectId)?.key).toBe('/repo/code-agent');
  });
});

describe('getSidebarGroupKeyForSession', () => {
  it('uses project id before workingDirectory for sidebar expansion state', () => {
    const session = makeSession({
      workingDirectory: '/repo/code-agent',
      projectId: 'proj-code-agent',
    });

    expect(getSidebarGroupKeyForSession(session)).toBe('project:proj-code-agent');
  });

  it('falls back to full workspace path when the session has no project metadata', () => {
    const session = makeSession({ workingDirectory: '/repo/code-agent' });

    expect(getSidebarGroupKeyForSession(session)).toBe('/repo/code-agent');
  });

  it('keeps blank sessions in the uncategorized group', () => {
    const session = makeSession({ workingDirectory: undefined });

    expect(getSidebarGroupKeyForSession(session)).toBe(UNCATEGORIZED_WORKSPACE_KEY);
  });
});

describe('isWorkspaceExpanded', () => {
  it('defaults to expanded when no entry exists', () => {
    expect(isWorkspaceExpanded({}, 'any-key')).toBe(true);
  });

  it('collapses only when entry is explicitly false', () => {
    expect(isWorkspaceExpanded({ foo: false }, 'foo')).toBe(false);
    expect(isWorkspaceExpanded({ foo: true }, 'foo')).toBe(true);
    expect(isWorkspaceExpanded({ foo: false }, 'bar')).toBe(true);
  });
});
