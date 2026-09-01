// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  listener: null as ((event: AgentEventEnvelope) => void) | null,
  openPreview: vi.fn(),
  openSurfaceForArtifact: vi.fn(),
  suppressSurfaceIntentForCurrentTurn: vi.fn(),
  appState: {
    workingDirectory: '/workspace',
    activeWorkbenchTab: 'overview' as string | null,
    openPreview: vi.fn(),
  },
  sessionState: { currentSessionId: 'session-1' as string | null },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: vi.fn((_channel: string, listener: (event: AgentEventEnvelope) => void) => {
      mocks.listener = listener;
      return () => { mocks.listener = null; };
    }),
  },
}));

vi.mock('../../../src/renderer/services/surfaceIntentDispatcher', () => ({
  openSurfaceForArtifact: mocks.openSurfaceForArtifact,
}));

vi.mock('../../../src/renderer/services/surfaceIntentRuntime', () => ({
  suppressSurfaceIntentForCurrentTurn: mocks.suppressSurfaceIntentForCurrentTurn,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: { getState: () => mocks.appState },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: { getState: () => mocks.sessionState },
}));

const { useArtifactFollow } = await import('../../../src/renderer/hooks/useArtifactFollow');
const { artifactFollowKey, useArtifactFollowStore } = await import(
  '../../../src/renderer/stores/artifactFollowStore'
);

function emit(event: AgentEventEnvelope): void {
  act(() => mocks.listener?.(event));
}

function writeStart(): AgentEventEnvelope {
  return {
    type: 'tool_call_start',
    streamEpoch: 'native:artifact-follow-test',
    sessionId: 'session-1',
    seq: 1,
    data: {
      id: 'write-1',
      name: 'Write',
      arguments: { file_path: 'report.html', content: '<main />' },
    },
  };
}

beforeEach(() => {
  mocks.openSurfaceForArtifact.mockReset();
  mocks.openSurfaceForArtifact.mockReturnValue({ view: 'file-preview', filePath: '/workspace/report.html' });
  mocks.suppressSurfaceIntentForCurrentTurn.mockReset();
  mocks.appState.openPreview.mockReset();
  mocks.appState.activeWorkbenchTab = 'overview';
  mocks.sessionState.currentSessionId = 'session-1';
  useArtifactFollowStore.getState().reset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useArtifactFollow', () => {
  it('opens the preview automatically when a supported file write starts while idle', () => {
    const { unmount } = renderHook(() => useArtifactFollow());
    emit(writeStart());

    expect(mocks.openSurfaceForArtifact).toHaveBeenCalledWith({
      artifact: { kind: 'file-preview', filePath: '/workspace/report.html' },
      artifactSessionId: 'session-1',
    });
    expect(useArtifactFollowStore.getState().entries[
      artifactFollowKey('session-1', '/workspace/report.html')
    ]?.attention).toBe(false);
    unmount();
  });

  it('opens in the background with attention when the user recently clicked the workbench', () => {
    document.body.innerHTML = `
      <div id="workbench-root">
        <div data-testid="workbench-view-selector"></div>
        <button id="active-control">active</button>
      </div>
    `;
    const { unmount } = renderHook(() => useArtifactFollow());
    fireEvent.pointerDown(document.getElementById('active-control')!);
    emit(writeStart());

    expect(mocks.openSurfaceForArtifact).not.toHaveBeenCalled();
    expect(mocks.appState.openPreview).toHaveBeenCalledWith('/workspace/report.html', {
      source: 'auto',
      activate: false,
    });
    expect(useArtifactFollowStore.getState().entries[
      artifactFollowKey('session-1', '/workspace/report.html')
    ]?.attention).toBe(true);
    expect(mocks.suppressSurfaceIntentForCurrentTurn).toHaveBeenCalledTimes(1);
    unmount();
  });
});
