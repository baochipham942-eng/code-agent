// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import {
  OPEN_CONTEXT_HEALTH_EVENT,
  OPEN_SESSION_REPLAY_EVENT,
} from '../../../src/renderer/utils/workbenchViews';

describe('workbench view routing', () => {
  beforeEach(() => {
    useAppStore.setState({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      previewTabs: [],
      activePreviewTabId: null,
      selectedWorkspacePreviewId: null,
      showCapabilityHub: false,
      capabilityHubTab: 'experts',
      showProjectCollaborationPage: false,
      projectCollaborationPageProjectId: null,
    });
  });

  it('keeps task and workspace-preview as aliases of Overview', () => {
    useAppStore.getState().openWorkbenchTab('task');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview'],
      activeWorkbenchTab: 'overview',
    });

    useAppStore.getState().openWorkspacePreview('artifact-1');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview'],
      activeWorkbenchTab: 'overview',
      selectedWorkspacePreviewId: 'artifact-1',
    });
  });

  it('routes all four retired ids to their existing homes without creating tabs', () => {
    const onContextHealth = vi.fn();
    const onSessionReplay = vi.fn();
    window.addEventListener(OPEN_CONTEXT_HEALTH_EVENT, onContextHealth);
    window.addEventListener(OPEN_SESSION_REPLAY_EVENT, onSessionReplay);

    useAppStore.getState().openWorkbenchTab('skills');
    expect(useAppStore.getState()).toMatchObject({
      showCapabilityHub: true,
      capabilityHubTab: 'skills',
      workbenchTabs: [],
    });

    useAppStore.getState().openWorkbenchTab('context');
    useAppStore.getState().openWorkbenchTab('audit');
    expect(onContextHealth).toHaveBeenCalledOnce();
    expect(onSessionReplay).toHaveBeenCalledOnce();
    expect(useAppStore.getState().workbenchTabs).toEqual([]);

    useAppStore.getState().openWorkbenchTab('project-collab');
    expect(useAppStore.getState()).toMatchObject({
      showProjectCollaborationPage: true,
      workbenchTabs: [],
    });

    window.removeEventListener(OPEN_CONTEXT_HEALTH_EVENT, onContextHealth);
    window.removeEventListener(OPEN_SESSION_REPLAY_EVENT, onSessionReplay);
  });

  it('separates URL Browser state from file Preview state', () => {
    useAppStore.getState().openLivePreview('http://localhost:3000', 'server-1');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['browser'],
      activeWorkbenchTab: 'browser',
    });

    useAppStore.getState().openPreview('/tmp/output.html');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['browser', 'preview:/tmp/output.html'],
      activeWorkbenchTab: 'preview:/tmp/output.html',
    });

    const [liveTab, fileTab] = useAppStore.getState().previewTabs;
    useAppStore.getState().openWorkbenchTab('browser');
    expect(useAppStore.getState()).toMatchObject({
      activeWorkbenchTab: 'browser',
      activePreviewTabId: liveTab.id,
    });

    useAppStore.getState().openWorkbenchTab('preview:/tmp/output.html');
    expect(useAppStore.getState()).toMatchObject({
      activeWorkbenchTab: 'preview:/tmp/output.html',
      activePreviewTabId: fileTab.id,
    });
  });
});
