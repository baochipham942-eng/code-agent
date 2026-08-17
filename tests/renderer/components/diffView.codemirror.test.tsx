// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../../../src/renderer/components/DiffView';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      turnDiff: {
        viewer: {
          noChanges: '无变化',
          unified: '单栏',
          split: '双栏',
          collapseUnchanged: '折叠未变',
          expandUnchanged: '展开未变',
          inlineChanges: '字级高亮',
          lineChanges: '行级高亮',
          readOnlyAria: '只读文件差异',
        },
      },
    },
  }),
}));

describe('DiffView CodeMirror Merge', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts a read-only unified merge view with CM-owned folding and inline diff', async () => {
    const oldText = ['head', ...Array.from({ length: 20 }, (_, i) => `same ${i}`), 'old'].join('\n');
    const newText = ['head', ...Array.from({ length: 20 }, (_, i) => `same ${i}`), 'new'].join('\n');
    const { container } = render(
      <DiffView oldText={oldText} newText={newText} fileName="sample.ts" stats={{ added: 1, removed: 1 }} />,
    );

    await waitFor(() => expect(container.querySelector('[data-diff-render-complete="true"]')).not.toBeNull());
    expect(container.querySelector('[data-diff-renderer="codemirror-merge"]')).not.toBeNull();
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('[contenteditable="false"]')).not.toBeNull();
    expect(screen.getByText('sample.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '折叠未变' })));
    await waitFor(() => expect(container.querySelector('.cm-collapsedLines')).not.toBeNull());
  });

  it('switches to CM split view and follows semantic theme tokens', async () => {
    const { container } = render(<DiffView oldText={'same\nold'} newText={'same\nnew'} fileName="mode.ts" />);
    await waitFor(() => expect(container.querySelector('[data-diff-render-complete="true"]')).not.toBeNull());

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '字级高亮' })));
    await waitFor(() => expect(screen.getByRole('button', { name: '行级高亮' })).toBeTruthy());

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '双栏' })));
    await waitFor(() => expect(container.querySelector('[data-diff-view-mode="split"]')).not.toBeNull());
    expect(container.querySelector('.cm-mergeView')).not.toBeNull();

    const styles = Array.from(document.querySelectorAll('style')).map((node) => node.textContent).join('\n');
    expect(styles).toContain('var(--bg-surface)');
    expect(styles).toContain('var(--badge-success-bg)');
    document.documentElement.setAttribute('data-theme', 'high-contrast-light');
    expect(container.querySelector('.cm-mergeView')).not.toBeNull();
  });

  it('uses localized empty state without mounting an editor', async () => {
    render(<DiffView oldText="same" newText="same" />);
    expect(await screen.findByText('无变化')).toBeTruthy();
    expect(document.querySelector('.cm-editor')).toBeNull();
  });
});
