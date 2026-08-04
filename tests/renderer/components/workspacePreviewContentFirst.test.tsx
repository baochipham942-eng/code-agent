// @vitest-environment jsdom
// ============================================================================
// 右栏是产物本身，不是「关于产物的清单」
// ============================================================================
// 与 Codex app 三栏对比得出的结论：Neo 右栏一屏放了计数条 + 视图图标 + 每个文件行
// 常驻 4 个动作 + 版本区 + 恢复检查点 + 打开预览 + 项目全部产物 —— 十几个可点元素、
// 零内容；Codex 直接把报告渲染出来。
//
// 这条门钉「默认那一屏是内容」：产物内容必须在，元数据/动作/版本必须都不在（各自
// 在自己的收纳里）。任何一个被搬回默认视图都会红。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  getProjectArtifacts: vi.fn(),
  addLibraryItem: vi.fn(),
  items: [] as unknown[],
}));

function item(id: string, title: string) {
  return {
    id,
    title,
    kind: 'document',
    status: 'ready',
    source: { messageId: `message-${id}`, label: '第一版' },
    file: { path: `/workspace/${id}.md`, name: `${id}.md` },
    content: { text: `${title} 的正文内容` },
  };
}

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => mocks.items,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
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
    presets: [], recipes: [],
  }),
}));

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    applyWorkbenchPreset: vi.fn(), applyWorkbenchRecipe: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: mocks.invoke, invokeDomain: mocks.invokeDomain },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ addLibraryItem: mocks.addLibraryItem }));
vi.mock('../../../src/renderer/services/projectClient', () => ({ getProjectArtifacts: mocks.getProjectArtifacts }));
vi.mock('../../../src/renderer/components/QuestionFormPreview', () => ({
  DESIGN_BRIEF_SUBMIT_EVENT: 'design-brief-submit',
}));

// 内容区与版本区用可辨认的探针替身：断言的是"它在不在默认那一屏"，不是它长什么样
vi.mock('../../../src/renderer/components/workspacePreview/parts', async () => {
  const { createElement } = await import('react');
  return {
    KindIcon: () => null,
    DesignBriefBadge: () => null,
    PreviewListItem: ({ item: listItem, onSelect }: { item: { id: string; title: string }; onSelect: () => void }) => (
      createElement('button', { type: 'button', onClick: onSelect }, `切到 ${listItem.title}`)
    ),
    RevisionPanel: () => createElement('div', null, '版本区探针'),
    PreviewBody: ({ item: bodyItem }: { item: { content?: { text?: string } } }) => (
      createElement('div', null, bodyItem.content?.text ?? '')
    ),
  };
});

const { WorkspacePreviewPanel } = await import('../../../src/renderer/components/WorkspacePreviewPanel');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectArtifacts.mockResolvedValue([]);
  mocks.items = [item('alpha', '季度报告'), item('beta', '附录表格')];
});

afterEach(cleanup);

describe('右栏默认那一屏是产物内容', () => {
  it('内容在，版本区和动作都不在', () => {
    render(<WorkspacePreviewPanel />);

    // 内容：直接渲染出来
    expect(screen.getByText('季度报告 的正文内容')).toBeTruthy();

    // 版本区 / 恢复检查点 / 归档删除：都在收纳里，默认那一屏不许出现
    expect(screen.queryByText('版本区探针')).toBeNull();
    expect(screen.queryByRole('button', { name: '归档到资料库: 季度报告' })).toBeNull();

    // 切换列表默认收起：不是常驻清单
    expect(screen.queryByRole('button', { name: '切到 附录表格' })).toBeNull();
  });

  it('点开「详情与版本」才出现元数据、动作和版本区', () => {
    render(<WorkspacePreviewPanel />);

    fireEvent.click(screen.getByTestId('workspace-preview-details-toggle'));

    expect(screen.getByText('版本区探针')).toBeTruthy();
    expect(screen.getByRole('button', { name: '归档到资料库: 季度报告' })).toBeTruthy();
    // 内容不会因为点开详情而消失
    expect(screen.getByText('季度报告 的正文内容')).toBeTruthy();
  });

  it('从概览直开产物时只显示产物，不带版本和项目归档入口', () => {
    render(<WorkspacePreviewPanel overviewMode />);

    expect(screen.getByText('季度报告 的正文内容')).toBeTruthy();
    expect(screen.queryByTestId('workspace-preview-details-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: '项目全部产物 · 1 会话' })).toBeNull();
  });

  it('默认选中排序里的第一条（最新/最高优先级那条）', () => {
    render(<WorkspacePreviewPanel />);

    expect(screen.getByText('季度报告 的正文内容')).toBeTruthy();
    expect(screen.queryByText('附录表格 的正文内容')).toBeNull();
  });

  it('多产物才给切换器，点开才列出，选完自动收起', () => {
    render(<WorkspacePreviewPanel />);

    fireEvent.click(screen.getByTestId('workspace-artifact-switcher'));
    expect(screen.getByRole('button', { name: '切到 附录表格' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '切到 附录表格' }));
    expect(screen.getByText('附录表格 的正文内容')).toBeTruthy();
    expect(screen.queryByText('季度报告 的正文内容')).toBeNull();
    expect(screen.queryByRole('button', { name: '切到 附录表格' })).toBeNull();
  });

  it('只有一个产物时不给切换器——下拉里只有它自己', () => {
    mocks.items = [item('alpha', '季度报告')];
    render(<WorkspacePreviewPanel />);

    expect(screen.queryByTestId('workspace-artifact-switcher')).toBeNull();
    expect(screen.getByText('季度报告 的正文内容')).toBeTruthy();
  });

  it('三处重复计数已收成一处：只有切换器上那个数字', () => {
    render(<WorkspacePreviewPanel />);

    expect(screen.getByTestId('workspace-artifact-switcher').textContent).toContain('共 2 个');
    // 原来的统计行「2 文件 · 0 图片 · 0 应用」和「文件 / 2」小标题都不该再有
    expect(document.body.textContent).not.toContain('文件 · ');
  });

  it('四个动作全在「⋯」里，默认不常驻', () => {
    render(<WorkspacePreviewPanel />);

    expect(screen.queryByRole('button', { name: '复制预览' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    const overflow = screen.getByTestId('workspace-preview-overflow');
    expect(overflow.textContent).toContain('复制预览');
    expect(overflow.textContent).toContain('导出打包');
    expect(overflow.textContent).toContain('工作台预设');
    expect(overflow.textContent).toContain('图库');
  });
});
