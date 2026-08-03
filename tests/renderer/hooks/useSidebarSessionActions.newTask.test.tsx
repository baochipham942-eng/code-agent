// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { useSidebarSessionActions } from '../../../src/renderer/components/features/sidebar/useSidebarSessionActions';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

describe('useSidebarSessionActions new task', () => {
  it('creates a plain session and brackets the request with the creating state', async () => {
    const setCreatingSessionMode = vi.fn();
    const createSession = vi.fn(async () => ({
      id: 'new-session',
      title: '新对话',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      turnCount: 0,
    }));
    const clearPlanningState = vi.fn();
    const setWorkspaceExpanded = vi.fn();
    const params = {
      collapseTimersRef: { current: {} },
      setCollapsingWorkspaces: vi.fn(),
      setWorkspaceExpanded,
      isCreatingSession: false,
      creatingWorkspaceKey: null,
      setCreatingSessionMode,
      setCreatingWorkspaceKey: vi.fn(),
      createSession,
      clearPlanningState,
      setWorkingDirectory: vi.fn(),
      multiSelectMode: false,
      toggleSelection: vi.fn(),
      searchQuery: '',
      messageSearchHitsBySessionId: {},
      setPendingSearchJump: vi.fn(),
      currentSessionId: null,
      switchSession: vi.fn(async () => undefined),
      unarchiveSession: vi.fn(async () => undefined),
      archiveSession: vi.fn(async () => undefined),
      openWorkspacePreview: vi.fn(),
      setProjectMetaById: vi.fn(),
      t: zh,
    } as Parameters<typeof useSidebarSessionActions>[0];
    const view = renderHook(() => useSidebarSessionActions(params));

    await act(async () => {
      await view.result.current.handleNewChat();
    });

    expect(createSession).toHaveBeenCalledWith('新对话', { workingDirectory: null });
    expect(setCreatingSessionMode.mock.calls).toEqual([['current'], [null]]);
    expect(setWorkspaceExpanded).toHaveBeenCalled();
    expect(clearPlanningState).toHaveBeenCalledTimes(1);
  });

  it('creates an independent space from the selected working directory', async () => {
    invokeDomain.mockResolvedValue('/workspace/selected');
    const createSession = vi.fn(async () => ({
      id: 'workspace-session',
      title: '新对话',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      turnCount: 0,
    }));
    const setWorkingDirectory = vi.fn();
    const setWorkspaceExpanded = vi.fn();
    const params = {
      collapseTimersRef: { current: {} },
      setCollapsingWorkspaces: vi.fn(),
      setWorkspaceExpanded,
      isCreatingSession: false,
      creatingWorkspaceKey: null,
      setCreatingSessionMode: vi.fn(),
      setCreatingWorkspaceKey: vi.fn(),
      createSession,
      clearPlanningState: vi.fn(),
      setWorkingDirectory,
      multiSelectMode: false,
      toggleSelection: vi.fn(),
      searchQuery: '',
      messageSearchHitsBySessionId: {},
      setPendingSearchJump: vi.fn(),
      currentSessionId: null,
      switchSession: vi.fn(async () => undefined),
      unarchiveSession: vi.fn(async () => undefined),
      archiveSession: vi.fn(async () => undefined),
      openWorkspacePreview: vi.fn(),
      setProjectMetaById: vi.fn(),
      t: zh,
    } as Parameters<typeof useSidebarSessionActions>[0];
    const view = renderHook(() => useSidebarSessionActions(params));

    await act(async () => {
      await view.result.current.handleNewIndependentSpace();
    });

    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
    expect(createSession).toHaveBeenCalledWith('新对话', {
      workingDirectory: '/workspace/selected',
    });
    expect(setWorkingDirectory).toHaveBeenCalledWith('/workspace/selected');
    expect(setWorkspaceExpanded).toHaveBeenCalledWith('/workspace/selected', true);
  });
});
