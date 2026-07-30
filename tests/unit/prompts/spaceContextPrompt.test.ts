import { describe, expect, it, vi } from 'vitest';
import type { ProjectDetail, WorkspaceScope } from '../../../src/shared/contract/project';
import {
  buildSpaceContextPrompt,
  type SpaceContextPromptDependencies,
} from '../../../src/host/prompts/spaceContextPrompt';

const scope: WorkspaceScope = {
  projectId: 'proj_space',
  primaryRoot: '/tmp/work',
  roots: [],
  version: 'v1',
};

function detail(spacePromotedAt: number | null = 1): ProjectDetail {
  return {
    project: {
      id: 'proj_space',
      name: 'Launch room',
      description: 'Coordinate the launch',
      workspacePath: '/tmp/work',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      spacePromotedAt,
    },
    sources: [],
    goals: [],
    roles: [{ projectId: 'proj_space', roleId: 'pm', joinedAt: 1 }],
    sessionIds: ['session_1'],
  };
}

function dependencies(overrides: Partial<SpaceContextPromptDependencies> = {}): SpaceContextPromptDependencies {
  return {
    getProjectDetail: vi.fn(() => detail()),
    getSessionProjectId: vi.fn(() => 'proj_space'),
    getLatestUserAuthorId: vi.fn(() => 'member_2'),
    listExperts: vi.fn(() => [{
      displayName: 'Aix',
      profession: 'Product lead',
      description: 'Owns delivery',
    }]),
    listSkills: vi.fn(() => ['planning']),
    listConnectors: vi.fn(() => ['lark']),
    listAutomations: vi.fn(() => ['Daily brief']),
    ...overrides,
  };
}

describe('buildSpaceContextPrompt', () => {
  it('injects configured capabilities and the current message author for an explicit space', () => {
    const block = buildSpaceContextPrompt('session_1', scope, dependencies());
    expect(block).toContain('space_name: Launch room');
    expect(block).toContain('initiating_user_id: member_2');
    expect(block).toContain('Aix · Product lead: Owns delivery');
    expect(block).toContain('selected_skills: planning');
    expect(block).toContain('selected_connectors: lark');
    expect(block).toContain('selected_automations: Daily brief');
    expect(block).toContain('artifacts as belonging to this space');
  });

  it('renders empty selections explicitly and uses the session-owner fallback supplied by the repository', () => {
    const block = buildSpaceContextPrompt('session_1', scope, dependencies({
      getLatestUserAuthorId: vi.fn(() => 'session_owner'),
      listExperts: vi.fn(() => []),
      listSkills: vi.fn(() => []),
      listConnectors: vi.fn(() => []),
      listAutomations: vi.fn(() => []),
    }));
    expect(block).toContain('initiating_user_id: session_owner');
    expect(block).toContain('selected_experts: (none)');
    expect(block).toContain('selected_skills: (none)');
  });

  it('has zero prompt cost outside an explicit collaboration space', () => {
    expect(buildSpaceContextPrompt('session_1', undefined, dependencies())).toBeNull();
    expect(buildSpaceContextPrompt('session_1', scope, dependencies({
      getProjectDetail: vi.fn(() => detail(null)),
    }))).toBeNull();
    expect(buildSpaceContextPrompt('session_1', scope, dependencies({
      getSessionProjectId: vi.fn(() => 'another_project'),
    }))).toBeNull();
  });
});
