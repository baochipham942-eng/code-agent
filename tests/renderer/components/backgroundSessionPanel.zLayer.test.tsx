// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { Modal } from '../../../src/renderer/components/primitives/Modal';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { Z_LAYERS } from '../../../src/renderer/styles/zLayers';

// 常驻浮动面板必须低于 modal：模态打开时被遮罩压暗，面板里的任务按钮不能再抢在遮罩之上
function zIndexOf(el: Element | null): number {
  return Number((el as HTMLElement | null)?.style.zIndex);
}

function findPanelRoot(): HTMLElement {
  const root = document.querySelector('.fixed.bottom-4.right-4') as HTMLElement | null;
  expect(root).not.toBeNull();
  return root as HTMLElement;
}

function renderPanelWithModal() {
  return render(
    <>
      <BackgroundSessionPanel />
      <Modal isOpen onClose={() => {}} title="确认更新">
        <p>modal body</p>
      </Modal>
    </>
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

  it('展开态：面板 z-index 严格小于 Modal 遮罩容器', () => {
    renderPanelWithModal();
    const panelZ = zIndexOf(findPanelRoot());
    const modalZ = zIndexOf(screen.getByRole('dialog').parentElement);
    expect(panelZ).toBe(Z_LAYERS.floatingPanel);
    expect(modalZ).toBe(Z_LAYERS.modal);
    expect(panelZ).toBeLessThan(modalZ);
  });

  it('收起态：胶囊按钮 z-index 严格小于 Modal 遮罩容器', () => {
    renderPanelWithModal();
    fireEvent.click(findPanelRoot().querySelector('button') as HTMLElement);
    const capsule = screen.getByText('1 个后台任务').closest('button');
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
      </>
    );
    act(() => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('后台任务一')).toBeTruthy();
    expect(zIndexOf(findPanelRoot())).toBe(Z_LAYERS.floatingPanel);
  });
});
