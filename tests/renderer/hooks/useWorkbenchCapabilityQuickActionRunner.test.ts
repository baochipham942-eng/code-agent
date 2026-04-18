import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const sessionState = {
  currentSessionId: 'session-1' as string | null,
};

const appState = {
  openSettingsTab: vi.fn(),
};

const skillState = {
  mountSkill: vi.fn(async () => true),
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector: (state: typeof skillState) => unknown) => selector(skillState),
}));

vi.mock('../../../src/renderer/hooks/useMcpStatus', () => ({
  requestMcpStatusReload: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(),
  },
}));

import {
  __getWorkbenchCapabilityQuickActionSessionStateForTests,
  __resetWorkbenchCapabilityQuickActionStateForTests,
  useWorkbenchCapabilityQuickActionRunner,
} from '../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner';

let latestRunner: ReturnType<typeof useWorkbenchCapabilityQuickActionRunner> | null = null;

function HookProbe() {
  latestRunner = useWorkbenchCapabilityQuickActionRunner();
  return React.createElement('div');
}

describe('useWorkbenchCapabilityQuickActionRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionState.currentSessionId = 'session-1';
    skillState.mountSkill.mockClear();
    appState.openSettingsTab.mockClear();
    latestRunner = null;
    __resetWorkbenchCapabilityQuickActionStateForTests();
  });

  afterEach(() => {
    __resetWorkbenchCapabilityQuickActionStateForTests();
    vi.useRealTimers();
  });

  it('scopes quick-action completion feedback to the current session', async () => {
    renderToStaticMarkup(React.createElement(HookProbe));

    await latestRunner?.runQuickAction(
      {
        kind: 'skill',
        key: 'skill:draft-skill',
        id: 'draft-skill',
        label: 'draft-skill',
        selected: true,
        mounted: false,
        installState: 'available',
        description: 'Draft release notes',
        source: 'community',
        libraryId: 'community',
        available: false,
        blocked: true,
        visibleInWorkbench: true,
        health: 'inactive',
        lifecycle: {
          installState: 'installed',
          mountState: 'unmounted',
          connectionState: 'not_applicable',
        },
        blockedReason: {
          code: 'skill_not_mounted',
          detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
          hint: '去 TaskPanel/Skills 把它挂到当前会话。',
          severity: 'warning',
        },
      },
      {
        kind: 'mount_skill',
        label: '挂载',
        emphasis: 'primary',
      },
    );

    expect(
      __getWorkbenchCapabilityQuickActionSessionStateForTests('session-1')
        .completedActions['skill:draft-skill']?.kind,
    ).toBe('mount_skill');

    sessionState.currentSessionId = 'session-2';
    renderToStaticMarkup(React.createElement(HookProbe));
    expect(latestRunner?.completedActions).toEqual({});

    sessionState.currentSessionId = 'session-1';
    renderToStaticMarkup(React.createElement(HookProbe));
    expect(
      __getWorkbenchCapabilityQuickActionSessionStateForTests('session-1')
        .completedActions['skill:draft-skill']?.kind,
    ).toBe('mount_skill');
  });

  it('reuses stable empty objects when the current session has no quick-action state yet', () => {
    sessionState.currentSessionId = 'fresh-session';

    renderToStaticMarkup(React.createElement(HookProbe));
    const firstActionErrors = latestRunner?.actionErrors;
    const firstCompletedActions = latestRunner?.completedActions;

    renderToStaticMarkup(React.createElement(HookProbe));

    expect(latestRunner?.actionErrors).toBe(firstActionErrors);
    expect(latestRunner?.completedActions).toBe(firstCompletedActions);
  });
});
