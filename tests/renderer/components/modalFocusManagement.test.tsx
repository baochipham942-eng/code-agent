// @vitest-environment jsdom

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Modal } from '../../../src/renderer/components/primitives/Modal';

afterEach(cleanup);

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
});
