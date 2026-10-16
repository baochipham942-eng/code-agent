// @vitest-environment jsdom
// ============================================================================
// BackgroundSessionPanel 层级契约（vs Modal）
// ============================================================================
// 2026-10-11 rework 适配：面板从全局 fixed bottom-4 浮层迁入 ChatView 列内文档流，
// root 不再是 `.fixed.bottom-4.right-4`；携带 zIndex 的是列内卡片/收起胶囊本体。
// 本档只钉「面板压在模态遮罩之下」的层级契约（floatingPanel < modal），与 origin/main
// 版意图一致；不压 composer 的几何契约见 backgroundSessionPanel.placement.test.tsx。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { Modal } from '../../../src/renderer/components/primitives/Modal';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { Z_LAYERS } from '../../../src/renderer/styles/zLayers';

// 列内面板必须低于 modal：模态打开时被遮罩压暗，面板里的任务按钮不能再抢在遮罩之上
function zIndexOf(el: Element | null): number {
  return Number((el as HTMLElement | null)?.style.zIndex);
}

// 列内 root（data-testid="background-session-panel"）本身无定位无 zIndex，
// zIndex 挂在 root → 列容器 → 卡片 这层
function findPanelCard(): HTMLElement {
  const root = screen.getByTestId('background-session-panel');
  const card = root.firstElementChild?.firstElementChild as HTMLElement | null;
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

function renderPanelWithModal() {
  return render(
    <>
      <BackgroundSessionPanel />
      <Modal isOpen onClose={() => {}} title="确认更新">
        <p>modal body</p>
      </Modal>
    </>,
  );
}

describe('BackgroundSessionPanel 层级', () => {
  beforeEach(() => {
    useSessionStore.setState({
      backgroundSessions: [
        {
          sessionId: 's1',
          title: '后台任务一',
          startedAt: Date.now(),
          backgroundedAt: Date.now(),
          status: 'running',
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
  });

  it('floatingPanel 档严格低于 modal 档', () => {
    expect(Z_LAYERS.floatingPanel).toBeLessThan(Z_LAYERS.modal);
  });

  it('展开态：面板卡片 z-index 严格小于 Modal 遮罩容器', () => {
    renderPanelWithModal();
    const panelZ = zIndexOf(findPanelCard());
    const modalZ = zIndexOf(screen.getByRole('dialog').parentElement);
    expect(panelZ).toBe(Z_LAYERS.floatingPanel);
    expect(modalZ).toBe(Z_LAYERS.modal);
    expect(panelZ).toBeLessThan(modalZ);
  });

  it('收起态：胶囊按钮 z-index 严格小于 Modal 遮罩容器', () => {
    renderPanelWithModal();
    fireEvent.click(screen.getByRole('button', { name: '收起后台任务面板' }));
    const capsule = screen.getByTestId('background-session-panel-collapsed');
    const panelZ = zIndexOf(capsule);
    const modalZ = zIndexOf(screen.getByRole('dialog').parentElement);
    expect(panelZ).toBe(Z_LAYERS.floatingPanel);
    expect(panelZ).toBeLessThan(modalZ);
  });

  it('模态关闭后面板仍在且层级不变（恢复可交互）', () => {
    const { rerender } = renderPanelWithModal();
    rerender(
      <>
        <BackgroundSessionPanel />
        <Modal isOpen={false} onClose={() => {}} title="确认更新">
          <p>modal body</p>
        </Modal>
      </>,
    );
    act(() => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('后台任务一')).toBeTruthy();
    expect(zIndexOf(findPanelCard())).toBe(Z_LAYERS.floatingPanel);
  });
});
