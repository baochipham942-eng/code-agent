// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setSelectedId: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [{
    id: 'preview-1',
    title: '项目方案',
    kind: 'document',
    status: 'ready',
    source: { messageId: 'message-1', label: '第一版' },
    file: { path: '/workspace/plan.md', name: 'plan.md' },
  }],
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    selectedWorkspacePreviewId: 'preview-1',
    setSelectedWorkspacePreviewId: mocks.setSelectedId,
    setWorkingDirectory: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'session-1', sessions: [] };
  const useSessionStore = (selector: (value: typeof state) => unknown) => selector(state);
  useSessionStore.getState = () => state;
  return { useSessionStore };
});

vi.mock('../../../src/renderer/stores/workbenchPresetStore', () => ({
  useWorkbenchPresetStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    presets: [],
    recipes: [],
  }),
}));

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    applyWorkbenchPreset: vi.fn(),
    applyWorkbenchRecipe: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: mocks.invoke },
}));

vi.mock('../../../src/renderer/components/ProjectHeaderBar', () => ({
  default: () => null,
}));

vi.mock('../../../src/renderer/components/QuestionFormPreview', () => ({
  DESIGN_BRIEF_SUBMIT_EVENT: 'design-brief-submit',
}));

vi.mock('../../../src/renderer/components/WorkspaceAssets', async () => {
  const { createElement } = await import('react');
  return {
    AssetDrawerPanel: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
    AssetToolbarButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
      createElement('button', { type: 'button', onClick }, label)
    ),
    PromptAppLibrary: () => null,
    isGalleryItem: () => false,
  };
});

vi.mock('../../../src/renderer/components/workspacePreview/parts', async () => {
  const { createElement } = await import('react');
  return {
    KindIcon: () => null,
    DesignBriefBadge: () => null,
    PreviewListItem: () => null,
    RevisionPanel: ({ onRestore }: { onRestore: () => void }) => (
      createElement('button', { type: 'button', onClick: onRestore }, 'Restore checkpoint')
    ),
    PreviewBody: () => null,
  };
});

const { WorkspacePreviewPanel } = await import(
  '../../../src/renderer/components/WorkspacePreviewPanel'
);

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ success: true, filesRestored: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkspacePreviewPanel restore confirmation', () => {
  it('shows the consequence before restoring and does not call IPC directly', () => {
    render(<WorkspacePreviewPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }));

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '恢复到这个时间点？' })).toBeTruthy();
    expect(screen.getByText('将把工作区文件恢复到这个时间点，当前修改会被覆盖。')).toBeTruthy();
  });

  it('calls checkpoint rewind only after confirmation', async () => {
    render(<WorkspacePreviewPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }));
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CHECKPOINT_REWIND,
      'session-1',
      'message-1',
    ));
  });

  it('never calls checkpoint rewind after cancellation', () => {
    render(<WorkspacePreviewPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '恢复到这个时间点？' })).toBeNull();
  });
});
