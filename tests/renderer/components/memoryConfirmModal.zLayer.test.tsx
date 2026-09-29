// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryConfirmModal } from '../../../src/renderer/components/features/memory/MemoryConfirmModal';
import { Modal } from '../../../src/renderer/components/primitives/Modal';
import type { PendingMemoryConfirm } from '../../../src/renderer/hooks/useMemoryLearning';
import { Z_LAYERS } from '../../../src/renderer/styles/zLayers';

// 记忆待确认浮窗必须低于 modal：模态打开时被遮罩压暗，浮窗按钮不能抢在遮罩之上
function zIndexOf(el: Element | null): number {
  return Number((el as HTMLElement | null)?.style.zIndex);
}

const pending: PendingMemoryConfirm = {
  id: 'm1',
  content: '用户偏好简洁回答',
  confidence: 0.6,
  category: 'about_me',
  type: 'preference',
  timestamp: 0,
  authority: 'memory',
};

function renderWithModal() {
  return render(
    <>
      <MemoryConfirmModal pending={pending} onConfirm={() => {}} onDecline={() => {}} />
      <Modal isOpen onClose={() => {}} title="确认更新">
        <p>modal body</p>
      </Modal>
    </>
  );
}

describe('MemoryConfirmModal 层级', () => {
  afterEach(() => cleanup());

  it('浮窗 z-index 严格小于 modal 档，且小于 Modal 遮罩容器', () => {
    renderWithModal();
    const root = document.querySelector('.fixed.bottom-4.right-4') as HTMLElement | null;
    expect(root).not.toBeNull();
    const floatZ = zIndexOf(root);
    const modalZ = zIndexOf(screen.getByRole('dialog').parentElement);
    expect(floatZ).toBe(Z_LAYERS.floatingPanel);
    expect(floatZ).toBeLessThan(Z_LAYERS.modal);
    expect(modalZ).toBe(Z_LAYERS.modal);
    expect(floatZ).toBeLessThan(modalZ);
  });
});
