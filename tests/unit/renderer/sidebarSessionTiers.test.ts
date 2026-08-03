import { describe, expect, it } from 'vitest';
import {
  buildSidebarSessionTierSections,
  resolveSidebarGroupTier,
  SIDEBAR_SESSION_TIER_ORDER,
} from '../../../src/renderer/utils/sidebarSessionTiers';
import type { SidebarProjectMeta } from '../../../src/renderer/utils/sidebarProjectSummary';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { WorkspaceGroup } from '../../../src/renderer/utils/workspaceGrouping';

function makeSession(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: overrides.id ?? 'session',
    title: overrides.title ?? 'Session',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    modelConfig: { provider: 'test' as any, model: 'test' },
    messageCount: overrides.messageCount ?? 0,
    turnCount: overrides.turnCount ?? 0,
    ...overrides,
  } as SessionWithMeta;
}

function makeGroup(overrides: Partial<WorkspaceGroup> & { key: string; sessionCount?: number }): WorkspaceGroup {
  const sessions = Array.from({ length: overrides.sessionCount ?? 1 }, (_, index) =>
    makeSession({ id: `${overrides.key}-s${index}`, updatedAt: 100 - index }),
  );
  return {
    name: overrides.key,
    paths: [],
    isUncategorized: false,
    latestActivityAt: 100,
    ...overrides,
    sessions: overrides.sessions ?? sessions,
  };
}

describe('resolveSidebarGroupTier（ADR-053 三分区判据）', () => {
  it('projectId 为空 → quick（未分类散会话与工作区无项目组同归快速对话）', () => {
    expect(resolveSidebarGroupTier(makeGroup({ key: 'uncat', projectId: undefined, isUncategorized: true }), {})).toBe('quick');
    expect(resolveSidebarGroupTier(makeGroup({ key: '/repo/loose', projectId: undefined }), {})).toBe('quick');
    expect(resolveSidebarGroupTier(makeGroup({ key: 'blank', projectId: '   ' }), {})).toBe('quick');
  });

  it('project.spacePromotedAt 非空 → space（协作空间）', () => {
    const meta: Record<string, SidebarProjectMeta> = {
      'proj-a': { name: 'A', spacePromotedAt: 1720000000000 },
    };
    expect(resolveSidebarGroupTier(makeGroup({ key: 'g', projectId: 'proj-a' }), meta)).toBe('space');
  });

  it('有 projectId 但未升级（null / 缺字段 / meta 未拉回）→ project（独立空间）', () => {
    expect(
      resolveSidebarGroupTier(makeGroup({ key: 'g', projectId: 'proj-a' }), { 'proj-a': { name: 'A', spacePromotedAt: null } }),
    ).toBe('project');
    expect(
      resolveSidebarGroupTier(makeGroup({ key: 'g', projectId: 'proj-a' }), { 'proj-a': { name: 'A' } }),
    ).toBe('project');
    // meta 异步未到达时先按 project 落位，到达后重算——与分组名/摘要同款异步语义
    expect(resolveSidebarGroupTier(makeGroup({ key: 'g', projectId: 'proj-missing' }), {})).toBe('project');
  });
});

describe('buildSidebarSessionTierSections', () => {
  it('分区顺序固定 space → project → quick，与输入顺序无关；组间相对顺序与组内排序不动', () => {
    const quick = makeGroup({ key: 'quick', projectId: undefined, isUncategorized: true, sessionCount: 2 });
    const projectB = makeGroup({ key: 'pb', projectId: 'proj-b', sessionCount: 1 });
    const space = makeGroup({ key: 'sp', projectId: 'proj-s', sessionCount: 3 });
    const projectA = makeGroup({ key: 'pa', projectId: 'proj-a', sessionCount: 1 });
    const meta: Record<string, SidebarProjectMeta> = {
      'proj-s': { spacePromotedAt: 1720000000000 },
      'proj-a': { spacePromotedAt: null },
      'proj-b': {},
    };
    // 输入故意乱序：quick 在最前，space 在中间
    const sections = buildSidebarSessionTierSections([quick, projectB, space, projectA], meta);
    expect(sections.map((section) => section.tier)).toEqual(['space', 'project', 'quick']);
    expect(SIDEBAR_SESSION_TIER_ORDER).toEqual(['space', 'project', 'quick']);
    // tier 内保持原相对顺序（projectB 先于 projectA）
    expect(sections[1].groups.map((group) => group.key)).toEqual(['pb', 'pa']);
    expect(sections.map((section) => section.sessionCount)).toEqual([3, 2, 2]);
  });

  it('空分区整节省略（节头也不渲染）', () => {
    const quick = makeGroup({ key: 'quick', projectId: undefined, isUncategorized: true });
    const sections = buildSidebarSessionTierSections([quick], {});
    expect(sections).toHaveLength(1);
    expect(sections[0].tier).toBe('quick');
    expect(buildSidebarSessionTierSections([], {})).toEqual([]);
  });

  it('过滤态下命中组仍按 tier 归位（「命中即显」子集行为）', () => {
    // 模拟搜索过滤后只剩 space 组与 quick 组：project 分区整节消失，其余归位不变
    const space = makeGroup({ key: 'sp', projectId: 'proj-s', sessionCount: 1 });
    const quick = makeGroup({ key: 'quick', projectId: undefined, isUncategorized: true, sessionCount: 1 });
    const sections = buildSidebarSessionTierSections([space, quick], {
      'proj-s': { spacePromotedAt: 1720000000000 },
    });
    expect(sections.map((section) => section.tier)).toEqual(['space', 'quick']);
  });
});
