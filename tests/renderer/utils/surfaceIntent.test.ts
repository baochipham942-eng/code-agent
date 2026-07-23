import { beforeEach, describe, expect, it } from 'vitest';
import {
  decideSurfaceIntent,
  findNewCurrentTurnPreviewArtifacts,
} from '../../../src/renderer/utils/surfaceIntent';
import {
  requestSurfaceIntent,
  resetSurfaceIntentRuntimeForTests,
} from '../../../src/renderer/services/surfaceIntentRuntime';
import { openSurfaceForArtifact } from '../../../src/renderer/services/surfaceIntentDispatcher';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

describe('surface intent unified decision', () => {
  beforeEach(() => {
    resetSurfaceIntentRuntimeForTests();
    useSessionStore.setState({
      currentSessionId: 'session-a',
      messages: [{
        id: 'user-turn-1',
        role: 'user',
        content: 'produce an artifact',
        timestamp: 1,
      }],
    });
    useAppStore.setState({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      previewTabs: [],
      activePreviewTabId: null,
      selectedWorkspacePreviewId: null,
      taskPanelTab: 'orchestration',
      workingDirectory: null,
    });
  });

  it('本轮首个新预览产物打开，第二个只进入列表不再抢焦点', () => {
    const firstProjection = findNewCurrentTurnPreviewArtifacts([
      {
        id: 'artifact-1',
        currentTurn: true,
        source: { turnNumber: 4 },
      },
    ], 4, new Set());
    expect(firstProjection.newItems.map((item) => item.id)).toEqual(['artifact-1']);

    const first = requestSurfaceIntent({
      artifact: { kind: 'workspace-preview', itemId: 'artifact-1' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      turnId: 'turn-4',
    });
    expect(first).toEqual({ view: 'workspace-preview', itemId: 'artifact-1' });

    const secondProjection = findNewCurrentTurnPreviewArtifacts([
      {
        id: 'artifact-1',
        currentTurn: true,
        source: { turnNumber: 4 },
      },
      {
        id: 'artifact-2',
        currentTurn: true,
        source: { turnNumber: 4 },
      },
    ], 4, firstProjection.observedIds);
    expect(secondProjection.newItems.map((item) => item.id)).toEqual(['artifact-2']);

    const second = requestSurfaceIntent({
      artifact: { kind: 'workspace-preview', itemId: 'artifact-2' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      turnId: 'turn-4',
    });
    expect(second).toBeNull();
  });

  it('用户手动切走后，本轮后续产物不自动打开', () => {
    expect(decideSurfaceIntent({
      artifact: { kind: 'design-canvas' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      hasAutoFocusedThisTurn: false,
      userSwitchedAwayThisTurn: true,
    })).toBeNull();

    expect(requestSurfaceIntent({
      artifact: { kind: 'design-canvas' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      turnId: 'turn-1',
    })).toEqual({ view: 'design-canvas' });
    useAppStore.getState().openWorkbenchTab('skills', { source: 'user' });
    expect(requestSurfaceIntent({
      artifact: { kind: 'file-preview', filePath: '/tmp/after-switch.pdf' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      turnId: 'turn-1',
    })).toBeNull();
  });

  it('带 sessionId 的背景会话产物 fail-closed，不打开', () => {
    expect(decideSurfaceIntent({
      artifact: { kind: 'file-preview', filePath: '/tmp/background.pptx' },
      artifactSessionId: 'session-b',
      currentSessionId: 'session-a',
      hasAutoFocusedThisTurn: false,
      userSwitchedAwayThisTurn: false,
    })).toBeNull();
    expect(decideSurfaceIntent({
      artifact: { kind: 'file-preview', filePath: '/tmp/legacy.pptx' },
      artifactSessionId: undefined,
      currentSessionId: 'session-a',
      hasAutoFocusedThisTurn: false,
      userSwitchedAwayThisTurn: false,
    })).toEqual({ view: 'file-preview', filePath: '/tmp/legacy.pptx' });
    expect(openSurfaceForArtifact({
      artifact: { kind: 'file-preview', filePath: '/tmp/background.pptx' },
      artifactSessionId: 'session-b',
    })).toBeNull();
    expect(useAppStore.getState().activeWorkbenchTab).toBeNull();
  });

  it('三类旧入口仍映射到文件预览、设计画布和 Team 监控', () => {
    const base = {
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      hasAutoFocusedThisTurn: false,
      userSwitchedAwayThisTurn: false,
    };
    expect(decideSurfaceIntent({
      ...base,
      artifact: { kind: 'file-preview', filePath: '/tmp/deck.pptx' },
    })).toEqual({ view: 'file-preview', filePath: '/tmp/deck.pptx' });
    expect(decideSurfaceIntent({
      ...base,
      artifact: { kind: 'design-canvas' },
    })).toEqual({ view: 'design-canvas' });
    expect(decideSurfaceIntent({
      ...base,
      artifact: { kind: 'swarm-monitor' },
    })).toEqual({ view: 'task-monitor' });
  });

  it.each([
    {
      name: 'PPTX bridge',
      artifact: { kind: 'file-preview', filePath: '/tmp/deck.pptx' } as const,
      assertState: () => {
        expect(useAppStore.getState().activeWorkbenchTab).toBe('preview:/tmp/deck.pptx');
      },
    },
    {
      name: 'canvas proposal',
      artifact: { kind: 'design-canvas' } as const,
      assertState: () => {
        expect(useAppStore.getState().activeWorkbenchTab).toBe('design-canvas');
      },
    },
    {
      name: 'swarm root event',
      artifact: { kind: 'swarm-monitor' } as const,
      assertState: () => {
        expect(useAppStore.getState()).toMatchObject({
          activeWorkbenchTab: 'task',
          taskPanelTab: 'monitor',
        });
      },
    },
  ])('$name 经统一 dispatcher 保持旧打开行为', ({ artifact, assertState }) => {
    expect(openSurfaceForArtifact({
      artifact,
      artifactSessionId: 'session-a',
    })).not.toBeNull();
    assertState();
  });

  it('新一轮恢复一次自动聚焦额度', () => {
    expect(requestSurfaceIntent({
      artifact: { kind: 'design-canvas' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      turnId: 'turn-1',
    })).toEqual({ view: 'design-canvas' });
    expect(requestSurfaceIntent({
      artifact: { kind: 'swarm-monitor' },
      artifactSessionId: 'session-a',
      currentSessionId: 'session-a',
      turnId: 'turn-2',
    })).toEqual({ view: 'task-monitor' });
  });
});
