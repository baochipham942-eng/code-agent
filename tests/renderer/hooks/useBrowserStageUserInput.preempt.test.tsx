// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStageUserInput } from '../../../src/renderer/hooks/useBrowserStageUserInput';
import type { BrowserStageUserInputOptions } from '../../../src/renderer/hooks/useBrowserStageUserInput';

const { controlMock, dispatchMock } = vi.hoisted(() => ({
  controlMock: vi.fn<(intent: unknown) => Promise<void>>(async () => undefined),
  dispatchMock: vi.fn<(input: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock('../../../src/renderer/services/surfaceExecutionController', () => ({
  executeSurfaceExecutionControl: (intent: unknown) => controlMock(intent),
}));
vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  dispatchUserBrowserInput: (input: unknown) => dispatchMock(input),
}));

function stageClick() {
  const currentTarget = {
    getBoundingClientRect: () => ({
      width: 200,
      height: 100,
      top: 0,
      left: 0,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    focus() {},
  };
  return {
    clientX: 40,
    clientY: 20,
    button: 0,
    detail: 1,
    currentTarget,
    preventDefault() {},
  } as unknown as React.MouseEvent<HTMLElement>;
}

function options(agentSurfaceState: BrowserStageUserInputOptions['agentSurfaceState']): BrowserStageUserInputOptions {
  return {
    conversationId: 'session-a',
    workspace: '/tmp/workspace-a',
    ownedByCurrentSession: true,
    annotateMode: false,
    ready: true,
    agentSurfaceBusy: true,
    contentWidth: 200,
    contentHeight: 100,
    surfaceSessionId: 'surface-agent',
    agentSurfaceState,
  };
}

describe('useBrowserStageUserInput preempt takeover', () => {
  beforeEach(() => {
    controlMock.mockReset().mockResolvedValue(undefined);
    dispatchMock.mockReset().mockResolvedValue(undefined);
  });

  it('calls takeover before dispatch and resets confirmation after waiting_human ends', async () => {
    const order: string[] = [];
    let releaseTakeover: () => void = () => undefined;
    controlMock.mockImplementation(() => new Promise((resolve) => {
      order.push('takeover');
      releaseTakeover = resolve;
    }));
    dispatchMock.mockImplementation(async () => {
      order.push('dispatch');
    });

    const view = renderHook(
      (props: BrowserStageUserInputOptions) => useBrowserStageUserInput(props),
      { initialProps: options('running') },
    );

    act(() => {
      view.result.current.onStageClick(stageClick());
    });
    expect(view.result.current.pendingPreemptInput).not.toBeNull();
    expect(controlMock).not.toHaveBeenCalled();

    act(() => {
      view.result.current.confirmPreempt();
    });
    await waitFor(() => expect(order).toEqual(['takeover']));
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(controlMock).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'session-a',
      surfaceSessionId: 'surface-agent',
      action: 'takeover',
    });

    await act(async () => {
      releaseTakeover();
    });
    await waitFor(() => expect(order).toEqual(['takeover', 'dispatch']));

    dispatchMock.mockClear();
    controlMock.mockClear();
    act(() => {
      view.result.current.onStageClick(stageClick());
    });
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(controlMock).not.toHaveBeenCalled();
    expect(view.result.current.pendingPreemptInput).toBeNull();

    view.rerender(options('waiting_human'));
    dispatchMock.mockClear();
    act(() => {
      view.result.current.onStageClick(stageClick());
    });
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(view.result.current.pendingPreemptInput).toBeNull();

    view.rerender(options('running'));
    dispatchMock.mockClear();
    act(() => {
      view.result.current.onStageClick(stageClick());
    });
    expect(view.result.current.pendingPreemptInput).not.toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('still dispatches the pending input when takeover control fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    controlMock.mockRejectedValue(new Error('session already ended'));
    const view = renderHook(() => useBrowserStageUserInput(options('running')));

    act(() => {
      view.result.current.onStageClick(stageClick());
    });
    act(() => {
      view.result.current.confirmPreempt();
    });

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(controlMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    const warning = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warning).toContain('Browser surface control failed');
    warn.mockRestore();
  });
});
