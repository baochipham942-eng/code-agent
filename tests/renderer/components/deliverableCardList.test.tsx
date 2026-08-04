// @vitest-environment jsdom
// ============================================================================
// DeliverableCardList 交互：状态 i18n、主体预览、归档常驻、更多菜单收敛
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeliverableCardView } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  openPreview: vi.fn(),
  openContentPreview: vi.fn(),
  openWorkspacePreview: vi.fn(),
  addLibraryItem: vi.fn(),
  invokeDomain: vi.fn(),
  copyPathToClipboard: vi.fn(),
  isWebMode: vi.fn(() => false),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({ t: mocks.language === 'en' ? en : zh, language: mocks.language }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openPreview: mocks.openPreview,
    openContentPreview: mocks.openContentPreview,
    openWorkspacePreview: mocks.openWorkspacePreview,
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [{
    id: 'artifact:ui',
    kind: 'generic_html',
    title: 'UI 原型',
    status: 'ready',
    createdAt: 1,
    source: { kind: 'message', label: 'Assistant' },
    content: { html: '<main>UI</main>' },
  }],
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

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  addLibraryItem: mocks.addLibraryItem,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  copyPathToClipboard: mocks.copyPathToClipboard,
  isWebMode: mocks.isWebMode,
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

mocks.language = 'zh';

const { DeliverableCardList } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/DeliverableCardList'
);

function baseCard(overrides: Partial<DeliverableCardView> = {}): DeliverableCardView {
  return {
    id: 'card-1',
    kind: 'document',
    title: '季度报告',
    description: 'Q3 总结',
    sourceLabel: 'Write',
    status: 'unverified',
    openTarget: { kind: 'file-preview', path: '/workspace/report.md' },
    contextPack: {
      deliverableType: 'Document',
      sourceOfTruth: ['/workspace/report.md'],
      constraints: [],
      priorArtifacts: [],
      acceptance: [],
      riskNotes: [],
    },
    contract: {
      purpose: 'summary',
      expectedOutput: 'report',
      inputRefs: [],
      requiredChecks: [],
    },
    evidencePack: {
      status: 'unverified',
      summary: 'pending',
      refs: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.language = 'zh';
  mocks.isWebMode.mockReturnValue(false);
});

afterEach(cleanup);

describe('DeliverableCardList 状态徽标 i18n', () => {
  it('中文界面显示中文状态徽标', () => {
    mocks.language = 'zh';
    const cards: DeliverableCardView[] = [
      baseCard({ id: 'v', title: '报告 A', status: 'verified' }),
      baseCard({ id: 'u', title: '报告 B', status: 'unverified' }),
      baseCard({ id: 'f', title: '报告 C', status: 'failed' }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.getAllByText('已验证')).toHaveLength(1);
    expect(screen.getAllByText('未验证')).toHaveLength(1);
    expect(screen.getAllByText('失败')).toHaveLength(1);
  });

  it('英文界面显示英文状态徽标', () => {
    mocks.language = 'en';
    const cards: DeliverableCardView[] = [
      baseCard({ id: 'v', title: 'Report A', status: 'verified' }),
      baseCard({ id: 'u', title: 'Report B', status: 'unverified' }),
      baseCard({ id: 'f', title: 'Report C', status: 'failed' }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.getAllByText('Verified')).toHaveLength(1);
    expect(screen.getAllByText('Unverified')).toHaveLength(1);
    expect(screen.getAllByText('Failed')).toHaveLength(1);
  });

  it('中文 quality 徽标走 i18n', () => {
    mocks.language = 'zh';
    const cards: DeliverableCardView[] = [
      baseCard({ id: 'p', title: '报告 A', quality: { status: 'passed', summary: 'ok' } }),
      baseCard({ id: 'n', title: '报告 B', quality: { status: 'needs_review', summary: 'check' } }),
      baseCard({ id: 'd', title: '报告 C', quality: { status: 'degraded', summary: 'degraded' } }),
      baseCard({ id: 'f', title: '报告 D', quality: { status: 'failed', summary: 'fail' } }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.getAllByText('质量通过')).toHaveLength(1);
    expect(screen.getAllByText('待复核')).toHaveLength(2);
    expect(screen.getAllByText('质量失败')).toHaveLength(1);
  });

  it('英文 quality 徽标走 i18n', () => {
    mocks.language = 'en';
    const cards: DeliverableCardView[] = [
      baseCard({ id: 'p', title: 'Report A', quality: { status: 'passed', summary: 'ok' } }),
      baseCard({ id: 'n', title: 'Report B', quality: { status: 'needs_review', summary: 'check' } }),
      baseCard({ id: 'd', title: 'Report C', quality: { status: 'degraded', summary: 'degraded' } }),
      baseCard({ id: 'f', title: 'Report D', quality: { status: 'failed', summary: 'fail' } }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.getAllByText('Validated')).toHaveLength(1);
    expect(screen.getAllByText('Needs review')).toHaveLength(2);
    expect(screen.getAllByText('Quality failed')).toHaveLength(1);
  });
});

describe('DeliverableCardList 主体点击与动作收敛', () => {
  it('点击卡片主体打开文件预览', () => {
    const cards = [baseCard({ title: '报告' })];
    render(<DeliverableCardList cards={cards} />);

    fireEvent.click(screen.getByRole('button', { name: '打开文件预览: 报告' }));
    expect(mocks.openPreview).toHaveBeenCalledWith('/workspace/report.md');
  });

  it('点击内容产物卡片一步打开内容 preview tab', () => {
    const cards = [
      baseCard({
        title: 'UI 原型',
        openTarget: { kind: 'workspace-preview', itemId: 'artifact:ui' },
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    fireEvent.click(screen.getByRole('button', { name: '在工作区预览中打开: UI 原型' }));
    expect(mocks.openContentPreview).toHaveBeenCalledWith({
      id: 'artifact:ui',
      title: 'UI 原型',
      content: '<main>UI</main>',
      format: 'html',
    });
    expect(mocks.openWorkspacePreview).not.toHaveBeenCalled();
  });

  it('归档按钮常驻，其他动作收进更多菜单', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'archive-to-library', label: 'archive', path: '/workspace/report.md', title: 'report.md' },
          { kind: 'reveal-file', label: 'reveal', path: '/workspace/report.md' },
          { kind: 'copy-reference', label: 'copy', value: '/workspace/report.md' },
        ],
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.getByRole('button', { name: '归档到资料库: 报告' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '在文件夹中显示: 报告' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '在文件夹中显示: 报告' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '更多: 报告' }));
    expect(screen.getByRole('menuitem', { name: '在文件夹中显示: 报告' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '复制路径或链接: 报告' })).toBeTruthy();
  });

  it('点击更多菜单项不触发卡片预览', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'archive-to-library', label: 'archive', path: '/workspace/report.md', title: 'report.md' },
          { kind: 'copy-reference', label: 'copy', value: '/workspace/report.md' },
        ],
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    fireEvent.click(screen.getByRole('button', { name: '更多: 报告' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '复制路径或链接: 报告' }));

    expect(mocks.openPreview).not.toHaveBeenCalled();
    expect(mocks.copyPathToClipboard).toHaveBeenCalledWith('/workspace/report.md');
  });

  it('按 Escape 关闭更多菜单', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'reveal-file', label: 'reveal', path: '/workspace/report.md' },
        ],
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    fireEvent.click(screen.getByRole('button', { name: '更多: 报告' }));
    expect(screen.getByRole('menuitem', { name: '在文件夹中显示: 报告' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('点击菜单外部关闭更多菜单', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'reveal-file', label: 'reveal', path: '/workspace/report.md' },
        ],
      }),
    ];
    render(
      <div>
        <DeliverableCardList cards={cards} />
        <button type="button">外部</button>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多: 报告' }));
    expect(screen.getByRole('menuitem', { name: '在文件夹中显示: 报告' })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('button', { name: '外部' }));
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('disabled 动作不显示，且无其他动作时不显示更多按钮', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'archive-to-library', label: 'archive', path: '/workspace/report.md', title: 'report.md' },
          { kind: 'reveal-file', label: 'reveal', path: '/workspace/report.md', disabled: true },
        ],
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.getByRole('button', { name: '归档到资料库: 报告' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更多: 报告' })).toBeNull();
  });

  it('没有归档动作但有其他动作时只显示更多按钮', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'reveal-file', label: 'reveal', path: '/workspace/report.md' },
        ],
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    expect(screen.queryByRole('button', { name: '归档到资料库: 报告' })).toBeNull();
    expect(screen.getByRole('button', { name: '更多: 报告' })).toBeTruthy();
  });

  it('菜单项执行后关闭菜单', () => {
    const cards = [
      baseCard({
        title: '报告',
        secondaryActions: [
          { kind: 'reveal-file', label: 'reveal', path: '/workspace/report.md' },
        ],
      }),
    ];
    render(<DeliverableCardList cards={cards} />);

    fireEvent.click(screen.getByRole('button', { name: '更多: 报告' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '在文件夹中显示: 报告' }));

    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});
