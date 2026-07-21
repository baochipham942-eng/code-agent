// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceControls } from '../../../../src/renderer/components/features/surfaceExecution';
import { surfaceExecutionZh } from '../../../../src/renderer/i18n/surfaceExecution';
import { surfaceSession } from './fixtures';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SurfaceControls', () => {
  it('exposes distinct takeover, stop, and end-session intents without renderer authority fields', async () => {
    const session = surfaceSession({ id: 'controls' });
    session.availableControls = ['pause', 'takeover', 'skip', 'stop', 'end_session'];
    const onControl = vi.fn().mockResolvedValue(undefined);
    render(<SurfaceControls session={session} copy={surfaceExecutionZh} onControl={onControl} />);

    expect(screen.getByRole('button', { name: /^暂停:/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^我来操作:/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^停止:/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^结束 Session:/ })).toBeTruthy();
    expect(screen.queryByText('skip')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^我来操作:/ }));
    await waitFor(() => expect(onControl).toHaveBeenCalledTimes(1));
    expect(onControl.mock.calls[0][0]).toEqual({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-controls',
      action: 'takeover',
    });
    expect(Object.keys(onControl.mock.calls[0][0]).sort()).toEqual([
      'action',
      'conversationId',
      'surfaceSessionId',
      'version',
    ]);
  });

  it('fails closed with a generic message and never renders Host error details', async () => {
    const onControl = vi.fn().mockRejectedValue(new Error('grantId=secret selector=#password'));
    const view = render(
      <SurfaceControls
        session={surfaceSession({ id: 'failure' })}
        copy={surfaceExecutionZh}
        onControl={onControl}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^停止:/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('控制请求未生效'));
    expect(view.container.innerHTML).not.toContain('grantId');
    expect(view.container.innerHTML).not.toContain('#password');
  });

  it('offers one explicit continuation for a native persisted checkpoint', async () => {
    const session = surfaceSession({ id: 'checkpoint', source: 'persisted', writable: false });
    session.availableControls = ['continue'];
    const onControl = vi.fn().mockResolvedValue(undefined);
    render(<SurfaceControls session={session} copy={surfaceExecutionZh} onControl={onControl} />);

    fireEvent.click(screen.getByRole('button', { name: /^从检查点续跑:/ }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-checkpoint',
      action: 'continue',
    }));
  });
});
