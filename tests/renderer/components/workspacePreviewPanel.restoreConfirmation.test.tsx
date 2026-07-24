// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  addLibraryItem: vi.fn(),
  getProjectArtifacts: vi.fn(),
  setSelectedId: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

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
  const state = {
    currentSessionId: 'session-1',
    sessions: [{ id: 'session-1', projectId: 'project-1', workingDirectory: '/workspace' }],
  };
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
  default: { invoke: mocks.invoke, invokeDomain: mocks.invokeDomain },
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  addLibraryItem: mocks.addLibraryItem,
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  getProjectArtifacts: mocks.getProjectArtifacts,
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

const { WorkspacePreviewPanel, dedupeProjectArtifacts, projectArtifactDisplayTitle } = await import(
  '../../../src/renderer/components/WorkspacePreviewPanel'
);
const { zh } = await import('../../../src/renderer/i18n/zh');

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ success: true, filesRestored: 1 });
  mocks.invokeDomain.mockReset();
  mocks.invokeDomain.mockResolvedValue({ success: true });
  mocks.addLibraryItem.mockReset();
  mocks.addLibraryItem.mockResolvedValue({ title: 'plan.md' });
  mocks.getProjectArtifacts.mockReset();
  mocks.getProjectArtifacts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkspacePreviewPanel restore confirmation', () => {
  it('uses friendly generated-artifact titles, truncates prompts, and deduplicates by kind plus title', () => {
    const labels = zh.sidebarProject.artifactKind;
    const longPrompt = '请根据本次用户研究结果生成一份覆盖信息架构、关键流程、异常场景和验收证据的完整交互方案';
    const artifacts = [
      { id: 'mermaid-1', sessionId: 'session-1', kind: 'mermaid' as const, title: 'graph TD; A-->B', createdAt: 3 },
      { id: 'mermaid-2', sessionId: 'session-2', kind: 'mermaid' as const, title: 'graph LR; C-->D', createdAt: 2 },
      { id: 'doc-1', sessionId: 'session-1', kind: 'document' as const, title: longPrompt, createdAt: 1 },
      { id: 'doc-2', sessionId: 'session-2', kind: 'document' as const, title: longPrompt, createdAt: 0 },
    ];

    expect(projectArtifactDisplayTitle(artifacts[0], labels)).toBe('图示');
    expect(projectArtifactDisplayTitle(artifacts[2], labels)).toBe(`${longPrompt.slice(0, 40)}…`);
    expect(dedupeProjectArtifacts(artifacts, labels).map((artifact) => artifact.id)).toEqual([
      'mermaid-1',
      'doc-1',
    ]);
  });

  it('keeps project artifacts collapsed and does not fetch them on first render', async () => {
    render(<WorkspacePreviewPanel />);

    expect(
      screen.getByRole('button', { name: '项目全部产物 · 1 会话' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(mocks.getProjectArtifacts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '项目全部产物 · 1 会话' }));

    await waitFor(() => expect(mocks.getProjectArtifacts).toHaveBeenCalledTimes(1));
    expect(mocks.getProjectArtifacts).toHaveBeenCalledWith('project-1');
  });

  it('archives file preview items with the current session context', async () => {
    render(<WorkspacePreviewPanel />);

    fireEvent.click(screen.getByRole('button', { name: '归档到资料库: 项目方案' }));

    await waitFor(() => expect(mocks.addLibraryItem).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'plan.md',
      kind: 'artifact',
      pathOrUri: '/workspace/plan.md',
      tags: ['定稿'],
      sourceSessionId: 'session-1',
    }));
    expect(mocks.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.ROLES, 'writeProjectMemory', expect.objectContaining({
      workspacePath: '/workspace',
      name: '项目方案',
    }));
  });

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
