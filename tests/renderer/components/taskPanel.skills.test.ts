import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const appState = {
  openSettingsTab: vi.fn(),
};

const quickActionRunnerState = {
  runningActionKey: null as string | null,
  actionErrors: {} as Record<string, string>,
  completedActions: {} as Record<string, { kind: string; completedAt: number }>,
  runQuickAction: vi.fn(),
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      taskPanel: {
        skills: '技能',
        noSkills: '没有技能',
        addSkills: '添加 Skills ({count})',
        more: '更多',
        manageSkills: '管理 Skills',
        unmountSkill: '卸载',
      },
    },
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: [],
    skills: [
      {
        kind: 'skill',
        key: 'skill:review-skill',
        id: 'review-skill',
        label: 'review-skill',
        selected: false,
        mounted: true,
        installState: 'mounted',
        description: 'Review code changes',
        source: 'library',
        libraryId: 'core',
        available: true,
        blocked: false,
        visibleInWorkbench: true,
        health: 'healthy',
        lifecycle: {
          installState: 'installed',
          mountState: 'mounted',
          connectionState: 'not_applicable',
        },
      },
      {
        kind: 'skill',
        key: 'skill:draft-skill',
        id: 'draft-skill',
        label: 'draft-skill',
        selected: false,
        mounted: false,
        installState: 'available',
        description: 'Draft release notes',
        source: 'library',
        libraryId: 'community',
        available: false,
        blocked: false,
        visibleInWorkbench: false,
        health: 'inactive',
        lifecycle: {
          installState: 'installed',
          mountState: 'unmounted',
          connectionState: 'not_applicable',
        },
      },
    ],
    connectors: [],
    mcpServers: [],
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    history: [
      {
        kind: 'skill',
        id: 'review-skill',
        label: 'review-skill',
        count: 1,
        lastUsed: 100,
        topActions: [],
      },
    ],
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => quickActionRunnerState,
}));

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: () => ({
    loading: false,
    mountSkill: vi.fn(),
    unmountSkill: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => appState,
}));

import { Skills } from '../../../src/renderer/components/TaskPanel/Skills';

describe('TaskPanel Skills', () => {
  it('renders mounted skill details and available skill count from workbench capabilities', () => {
    const html = renderToStaticMarkup(
      React.createElement(Skills),
    );

    expect(html).toContain('review-skill');
    expect(html).toContain('Review code changes');
    expect(html).toContain('添加 Skills (1)');
    expect(html).toContain('查看 review-skill 详情');
  });
});
