// @vitest-environment jsdom

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../../../src/renderer/components/primitives/Modal';

afterEach(cleanup);

describe('Modal backdrop', () => {
  it('点 backdrop 调 onClose（默认 closeOnBackdropClick=true）；点弹层容器自身不调', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen title="Backdrop test" onClose={onClose}>
        Dialog content
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    // backdrop = Modal 根 overlay 的第一个子元素（dialog 的兄弟）
    const backdrop = dialog.parentElement?.firstElementChild as Element;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnBackdropClick=false 时点 backdrop 不调 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen title="Backdrop disabled" onClose={onClose} closeOnBackdropClick={false}>
        Dialog content
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement?.firstElementChild as Element;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal focus management', () => {
  it('wraps Tab forward and Shift+Tab backward within the dialog', () => {
    render(
      <Modal isOpen title="Focus test" showCloseButton={false}>
        <button>First action</button>
        <button>Last action</button>
      </Modal>
    );

    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the trigger when the dialog closes', () => {
    const Harness = () => {
      const [isOpen, setIsOpen] = useState(false);

      return (
        <>
          <button onClick={() => setIsOpen(true)}>Open dialog</button>
          <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Restore focus">
            Dialog content
          </Modal>
        </>
      );
    };

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(document.activeElement).toBe(trigger);
  });

  it('uses a title-less custom header as the accessible dialog name', () => {
    render(
      <Modal isOpen header={<h2>Custom settings</h2>}>
        Dialog content
      </Modal>
    );

    expect(screen.getByRole('dialog', { name: 'Custom settings' })).toBeTruthy();
  });

  it('closes stacked modals one at a time and keeps body scroll locked', () => {
    const Harness = () => {
      const [isOuterOpen, setIsOuterOpen] = useState(true);
      const [isInnerOpen, setIsInnerOpen] = useState(false);

      return (
        <Modal
          isOpen={isOuterOpen}
          onClose={() => setIsOuterOpen(false)}
          title="Outer dialog"
        >
          <button onClick={() => setIsInnerOpen(true)}>Open inner dialog</button>
          <Modal
            isOpen={isInnerOpen}
            onClose={() => setIsInnerOpen(false)}
            title="Inner dialog"
          >
            Inner content
          </Modal>
        </Modal>
      );
    };

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner dialog' }));

    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Inner dialog' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Outer dialog' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
});
