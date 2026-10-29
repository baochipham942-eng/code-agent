// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const appState = {
  workingDirectory: '/repo/project',
  setWorkingDirectory: vi.fn(),
  openDevServerLauncher: vi.fn(),
  openWorkbenchTab: vi.fn(),
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  setShowSettings: vi.fn(),
  showLab: false,
  setShowLab: vi.fn(),
  showTimeCapabilityCenter: false,
  setShowTimeCapabilityCenter: vi.fn(),
  showDesktopPanel: false,
  setShowDesktopPanel: vi.fn(),
  showActivityPanel: false,
  setShowActivityPanel: vi.fn(),
  showLocalOpsPanel: false,
  openLocalOpsPanel: vi.fn(),
  setShowPromptManager: vi.fn(),
  setActiveInternalFeature: vi.fn(),
};
const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{
    id: 'session-1',
    title: 'Current session',
    workingDirectory: '/repo/project',
    messageCount: 2,
    turnCount: 1,
  }],
  sessionRuntimes: new Map([
    ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, lastActivityAt: 1 }],
  ]),
  backgroundSessions: [],
  pendingUserQuestionsBySessionId: new Map(),
  moveToBackground: vi.fn(),
};

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector: (state: { sessionStates: object }) => unknown) => selector({ sessionStates: {} }),
}));
vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (selector: (state: { runs: object }) => unknown) => selector({ runs: {} }),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }),
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: { user: null; signOut: () => void }) => unknown) => {
    const state = { user: null, signOut: vi.fn() };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../../src/renderer/stores/bundledCapabilityStore', () => ({
  useBundledCapabilityStore: (selector: (state: { installed: object }) => unknown) => selector({ installed: {} }),
}));
vi.mock('../../../src/renderer/internalFeatures/internalFeatureStore', () => ({
  useInternalFeatureStore: (selector: (state: { features: unknown[] }) => unknown) => selector({ features: [] }),
}));
vi.mock('../../../src/renderer/slots/productSlotHosts', () => ({
  NavAccountItemSlotHost: () => null,
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { SessionActionsMenu } from '../../../src/renderer/components/SessionActionsMenu';
import { SidebarAccountMenu } from '../../../src/renderer/components/features/sidebar/SidebarAccountMenu';

const sessionCopy = zh.sessionReplay.sessionActionsMenu;
const sidebarCopy = zh.sidebar;

function AccountMenuHarness() {
  const [open, setOpen] = useState(false);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={sidebarCopy.userMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Account
      </button>
      {open && (
        <SidebarAccountMenu
          onClose={() => setOpen(false)}
          advancedToolsOpen={advancedToolsOpen}
          onToggleAdvancedTools={() => setAdvancedToolsOpen((value) => !value)}
          hasActiveAdvancedTool={false}
        />
      )}
    </>
  );
}

afterEach(cleanup);

describe('SessionActionsMenu accessibility', () => {
  it('exposes a named menu, named items, and trigger expanded state', () => {
    render(<SessionActionsMenu />);
    const trigger = screen.getByRole('button', { name: sessionCopy.menuAria });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);

    expect(screen.getByRole('menu', { name: sessionCopy.menuAria })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: sessionCopy.resumeLabel })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: sessionCopy.livePreviewLabel })).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves focus with wrapping arrows and Home/End, skips disabled items, and restores focus on Escape', () => {
    render(<SessionActionsMenu />);
    const trigger = screen.getByRole('button', { name: sessionCopy.menuAria });
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitem');
    const disabledIndex = items.findIndex((item) => item.hasAttribute('disabled'));

    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowDown' });
    expect(disabledIndex).toBe(2);
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(items[3], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(items[items.length - 1], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape after focus leaves the open menu', () => {
    render(<SessionActionsMenu />);
    const trigger = screen.getByRole('button', { name: sessionCopy.menuAria });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SidebarAccountMenu accessibility', () => {
  it('exposes a named menu and marks the advanced-tools disclosure as a menu item', () => {
    render(<AccountMenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: sidebarCopy.userMenu }));

    expect(screen.getByRole('menu', { name: sidebarCopy.userMenu })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: sidebarCopy.menuActivity })).toBeTruthy();
    const advancedTools = screen.getByRole('menuitem', { name: sidebarCopy.advancedTools });
    expect(advancedTools.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advancedTools);
    expect(advancedTools.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menuitem', { name: sidebarCopy.menuModelTraining })).toBeTruthy();
  });

  it('moves focus with wrapping arrows and Home/End and restores trigger focus on Escape', () => {
    render(<AccountMenuHarness />);
    const trigger = screen.getByRole('button', { name: sidebarCopy.userMenu });
    trigger.focus();
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitem');

    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape after focus leaves the open menu', () => {
    render(<AccountMenuHarness />);
    const trigger = screen.getByRole('button', { name: sidebarCopy.userMenu });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
