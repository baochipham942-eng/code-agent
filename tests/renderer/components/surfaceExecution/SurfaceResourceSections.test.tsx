// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceResourceSections } from '../../../../src/renderer/components/features/surfaceExecution/SurfaceResourceSections';
import { surfaceExecutionZh } from '../../../../src/renderer/i18n/surfaceExecution';
import { surfaceSession } from './fixtures';

const surfaceClient = vi.hoisted(() => ({ getOutput: vi.fn() }));

vi.mock('../../../../src/renderer/services/surfaceExecutionClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/renderer/services/surfaceExecutionClient')>(),
  getSurfaceExecutionOutput: (...args: unknown[]) => surfaceClient.getOutput(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SurfaceResourceSections', () => {
  it('opens owner-scoped HTML as inert redacted text and never exposes raw refs', async () => {
    surfaceClient.getOutput.mockResolvedValue({
      version: 1,
      outputRef: 'surface-output://html-1',
      contentKind: 'text',
      mimeType: 'text/html',
      text: '<main data-deliverable="travel-site-final">token=surface-secret-canary-output</main>',
      bytes: 88,
      sha256: 'a'.repeat(64),
      truncated: false,
    });
    const session = surfaceSession({
      id: 'output',
      state: 'completed',
      writable: false,
      outputs: [
        { ref: 'surface-output://html-1', kind: 'file', label: 'travel-site-final.html' },
        { ref: 'trace://private-trace-ref', kind: 'trace', label: 'execution-proof.json' },
      ],
    });
    const view = render(<SurfaceResourceSections session={session} copy={surfaceExecutionZh} />);
    const entries = screen.getAllByTestId('surface-output-entry');

    fireEvent.click(within(entries[0]).getByRole('button', { name: '打开产物' }));
    await waitFor(() => expect(screen.getByTestId('surface-output-preview')).toBeTruthy());
    expect(surfaceClient.getOutput).toHaveBeenCalledWith({
      version: 1,
      conversationId: session.scope.conversationId,
      surfaceSessionId: session.scope.surfaceSessionId,
      outputRef: 'surface-output://html-1',
    });
    expect(screen.getByText(/data-deliverable="travel-site-final"/)).toBeTruthy();
    expect(view.container.textContent).toContain('[redacted]');
    expect(view.container.innerHTML).not.toContain('surface-secret-canary-output');
    expect(view.container.querySelector('main[data-deliverable]')).toBeNull();
    expect(view.container.innerHTML).not.toContain('surface-output://html-1');
    expect(view.container.innerHTML).not.toContain('trace://private-trace-ref');
    expect(within(entries[1]).getByRole('button', { name: '只读记录' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders an owner-scoped image payload and fails closed when a later read is rejected', async () => {
    surfaceClient.getOutput
      .mockResolvedValueOnce({
        version: 1,
        outputRef: 'surface-output://image-1',
        contentKind: 'image',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        bytes: 32,
        sha256: 'b'.repeat(64),
        truncated: false,
      })
      .mockRejectedValueOnce(new Error('owner blocked'));
    const session = surfaceSession({
      id: 'image-output',
      outputs: [
        { ref: 'surface-output://image-1', kind: 'artifact', label: 'final.png' },
        { ref: 'surface-output://foreign', kind: 'file', label: 'foreign.txt' },
      ],
    });
    render(<SurfaceResourceSections session={session} copy={surfaceExecutionZh} />);
    const entries = screen.getAllByTestId('surface-output-entry');

    fireEvent.click(within(entries[0]).getByRole('button', { name: '打开产物' }));
    await waitFor(() => expect(within(entries[0]).getByRole('img', { name: 'final.png' })).toBeTruthy());
    fireEvent.click(within(entries[1]).getByRole('button', { name: '打开产物' }));
    await waitFor(() => expect(within(entries[1]).getByText('产物不可用')).toBeTruthy());
    expect(within(entries[1]).queryByRole('img')).toBeNull();
  });
});
