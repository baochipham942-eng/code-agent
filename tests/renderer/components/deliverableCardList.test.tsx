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
  setWorkbenchCollapsed: vi.fn(),
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
    setWorkbenchCollapsed: mocks.setWorkbenchCollapsed,
  }),
}));

const uiPreviewItem = {
  id: 'artifact:ui',
  kind: 'generic_html',
  title: 'UI 原型',
  status: 'ready',
  createdAt: 1,
  source: { kind: 'message', label: 'Assistant' },
  content: { html: '<main>UI</main>' },
};

vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [uiPreviewItem],
  // 角色轴（ADR-055）：概览改用 …State 取 { items, materialItems }；替身要跟上新导出
  useWorkspacePreviewModelState: () => ({
    items: [uiPreviewItem],
    materialItems: [],
    currentTurnArtifacts: null,
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

// 🔴 这一组断言是产品决策的机器化，不是实现细节的快照。
// 爸 2026-08-16 看图拍板卡面降噪（#1208），2026-08-17 复述并给出更根本的理由：
// **「已验证」完全是内部术语，用户看到卡片就该默认它是已验证的**，所以卡面不展示验证状态。
// #1221 曾把本组断言整体反转（queryByText('已验证')).toBeNull() → getByTestId(...).toContain('已验证')
// 并追加三个「卡面 badge 映射」用例，CI 因此全绿放行、降噪成果被静默推翻。
// ⇒ 要改本组断言的方向，必须先拿到爸的新拍板并在 PR 里引用单号，不许顺手反转。
describe('DeliverableCardList 卡面降噪', () => {
  it('卡面只保留文件名与动作，不显示第二行、验证/质量徽标和眼睛图标', () => {
    const { container } = render(<DeliverableCardList cards={[baseCard({
      title: '报告',
      description: 'Document · Write · Created',
      status: 'verified',
      evidencePack: { status: 'verified', summary: 'ok', refs: [] },
      quality: { status: 'passed', summary: 'ok' },
      secondaryActions: [
        { kind: 'archive-to-library', label: 'archive', path: '/workspace/report.md', title: 'report.md' },
        { kind: 'copy-reference', label: 'copy', value: '/workspace/report.md' },
      ],
    })]} />);

    expect(screen.getByText('报告')).toBeTruthy();
    expect(screen.getByRole('button', { name: '归档到资料库: 报告' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更多: 报告' })).toBeTruthy();
    expect(screen.queryByText('Document · Write · Created')).toBeNull();
    expect(screen.queryByText('已就绪')).toBeNull();
    expect(screen.queryByText('质量通过')).toBeNull();
    expect(screen.queryByTestId('deliverable-evidence-status')).toBeNull();
    expect(container.querySelector('.lucide-eye')).toBeNull();
  });

  // 三种状态一个都不许漏到卡面上——只断言 verified 会让 unverified/failed 从别的分支漏出来。
  it.each([
    ['verified', '已就绪'],
    ['unverified', '未检查'],
    ['failed', '有问题'],
  ] as const)('evidencePack.status=%s 时卡面仍不出现「%s」徽章', (status, label) => {
    render(<DeliverableCardList cards={[baseCard({
      status,
      evidencePack: { status, summary: label, refs: [] },
    })]} />);

    expect(screen.queryByTestId('deliverable-evidence-status')).toBeNull();
    expect(screen.queryByText(label)).toBeNull();
  });
});

describe('DeliverableCardList 主体点击与动作收敛', () => {
  it('点击卡片主体打开文件预览', () => {
    const cards = [baseCard({ title: '报告' })];
    render(<DeliverableCardList cards={cards} />);

    fireEvent.click(screen.getByRole('button', { name: '打开文件预览: 报告' }));
    expect(mocks.setWorkbenchCollapsed).toHaveBeenCalledWith(false);
    expect(mocks.openPreview).toHaveBeenCalledWith('/workspace/report.md', {
      deliverableStatus: 'unverified',
    });
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

  it('点击归档按钮不冒泡到卡片预览', () => {
    mocks.addLibraryItem.mockResolvedValue({ title: 'report.md' });
    render(<DeliverableCardList cards={[baseCard({
      title: '报告',
      secondaryActions: [
        { kind: 'archive-to-library', label: 'archive', path: '/workspace/report.md', title: 'report.md' },
      ],
    })]} />);

    fireEvent.click(screen.getByRole('button', { name: '归档到资料库: 报告' }));

    expect(mocks.openPreview).not.toHaveBeenCalled();
    expect(mocks.addLibraryItem).toHaveBeenCalledTimes(1);
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
