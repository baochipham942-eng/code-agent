import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore, MAX_PREVIEW_TABS } from '../../../src/renderer/stores/appStore';

describe('appStore workbench tabs', () => {
  beforeEach(() => {
    // Reset: close all tabs. Task opens only from user action or live activity.
    useAppStore.setState({
      previewTabs: [],
      activePreviewTabId: null,
      workbenchTabs: [],
      activeWorkbenchTab: null,
      taskWorkbenchOpenSource: null,
      taskWorkbenchActivityActive: false,
      taskPanelTab: 'monitor',
      showCapabilityHub: false,
      capabilityHubTab: 'experts',
      showProjectCollaborationPage: false,
      projectCollaborationPageProjectId: null,
      showKnowledgeMemoryPanel: false,
      showComputerUsePanel: false,
      showInAppValidationPanel: false,
    });
  });

  it('starts with the workbench collapsed by default', () => {
    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual([]);
    expect(state.activeWorkbenchTab).toBeNull();
  });

  it('routes the legacy skills id to the capability center without adding a workbench tab', () => {
    useAppStore.getState().openWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual([]);
    expect(state.activeWorkbenchTab).toBeNull();
    expect(state.showCapabilityHub).toBe(true);
    expect(state.capabilityHubTab).toBe('skills');
  });

  it('routes the legacy audit id to the SessionActions replay home', () => {
    useAppStore.getState().openWorkbenchTab('audit');
    expect(useAppStore.getState().workbenchTabs).toEqual([]);
  });

  it('routes the legacy context id to ContextHealth', () => {
    useAppStore.getState().openWorkbenchTab('context');
    expect(useAppStore.getState().workbenchTabs).toEqual([]);
  });

  it('routes the legacy project collaboration id to its project page', () => {
    const { openWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();

    openWorkbenchTab('project-collab');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      showProjectCollaborationPage: true,
    });

    closeWorkbenchTab('project-collab');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      showProjectCollaborationPage: false,
    });
  });

  it('opens the project collaboration page with a project binding and closes sibling main panels', () => {
    useAppStore.setState({
      showKnowledgeMemoryPanel: true,
      showComputerUsePanel: true,
      showInAppValidationPanel: true,
    });

    useAppStore.getState().openProjectCollaborationPage(' project-1 ');

    expect(useAppStore.getState()).toMatchObject({
      showProjectCollaborationPage: true,
      projectCollaborationPageProjectId: 'project-1',
      showKnowledgeMemoryPanel: false,
      showComputerUsePanel: false,
      showInAppValidationPanel: false,
    });

    useAppStore.getState().closeProjectCollaborationPage();
    expect(useAppStore.getState()).toMatchObject({
      showProjectCollaborationPage: false,
      projectCollaborationPageProjectId: null,
    });
  });

  it('openWorkbenchTab on an already-open tab only re-activates (no duplicate)', () => {
    const { openWorkbenchTab, setActiveWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('task');
    openWorkbenchTab('files');
    setActiveWorkbenchTab('task');

    openWorkbenchTab('files');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['overview', 'files']);
    expect(state.activeWorkbenchTab).toBe('files');
  });

  it('openWorkspacePreview opens the workspace preview tab and tracks selected item', () => {
    useAppStore.getState().openWorkspacePreview('preview-item-1');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['overview']);
    expect(state.activeWorkbenchTab).toBe('overview');
    expect(state.selectedWorkspacePreviewId).toBe('preview-item-1');
  });

  it('closeWorkbenchTab removes tab and clears active when nothing remains', () => {
    const { openWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('task');
    closeWorkbenchTab('task');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual([]);
    expect(state.activeWorkbenchTab).toBeNull();
  });

  it('closeWorkbenchTab on active falls back to another pinned tab', () => {
    const { openWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('task');
    openWorkbenchTab('files');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('files');

    closeWorkbenchTab('files');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['overview']);
    expect(state.activeWorkbenchTab).toBe('overview');
  });

  it('closeWorkbenchTab on a non-active tab leaves active alone', () => {
    const { openWorkbenchTab, setActiveWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('task');
    openWorkbenchTab('files');
    setActiveWorkbenchTab('task');

    closeWorkbenchTab('files');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['overview']);
    expect(state.activeWorkbenchTab).toBe('overview');
  });

  it('closeWorkbenchTab on a preview also evicts the backing previewTab and promotes the next recent preview', () => {
    const { openPreview, setActivePreviewTab, closeWorkbenchTab } = useAppStore.getState();
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');
    openPreview('/tmp/c.md');
    const { previewTabs } = useAppStore.getState();
    const aId = previewTabs[0].id;
    const bId = previewTabs[1].id;
    const cId = previewTabs[2].id;
    setActivePreviewTab(aId);
    setActivePreviewTab(bId);
    setActivePreviewTab(cId);

    closeWorkbenchTab('preview:/tmp/c.md');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toContain('preview:/tmp/b.md');
    expect(state.workbenchTabs).not.toContain('preview:/tmp/c.md');
    expect(state.activeWorkbenchTab).toBe('preview:/tmp/b.md');
    // Closing a preview's workbench tab is a "close file" — the previewTab is evicted.
    expect(state.previewTabs.map((t) => t.id)).toEqual([aId, bId]);
    // activePreviewTabId follows suit so PreviewPanel renders the survivor.
    expect(state.activePreviewTabId).toBe(bId);
  });

  it('openPreview appends a preview:<path> entry to workbenchTabs and activates it', () => {
    useAppStore.getState().openPreview('/tmp/readme.md');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toContain('preview:/tmp/readme.md');
    expect(state.activeWorkbenchTab).toBe('preview:/tmp/readme.md');
  });

  it('openPreview on an already-open path re-activates without duplicating workbench entry', () => {
    const { openPreview, setActiveWorkbenchTab } = useAppStore.getState();
    openPreview('/tmp/a.md');
    useAppStore.getState().openWorkbenchTab('files');
    setActiveWorkbenchTab('files');

    openPreview('/tmp/a.md');

    const state = useAppStore.getState();
    expect(state.workbenchTabs.filter((w) => w === 'preview:/tmp/a.md')).toHaveLength(1);
    expect(state.activeWorkbenchTab).toBe('preview:/tmp/a.md');
  });

  it('LRU eviction during openPreview also removes the evicted workbench entry', () => {
    const { openPreview } = useAppStore.getState();
    const paths: string[] = [];
    for (let i = 0; i < MAX_PREVIEW_TABS; i++) {
      const p = `/tmp/f${i}.md`;
      paths.push(p);
      openPreview(p);
    }
    // Now at capacity. Oldest is /tmp/f0.md.
    openPreview('/tmp/overflow.md');

    const state = useAppStore.getState();
    expect(state.previewTabs).toHaveLength(MAX_PREVIEW_TABS);
    expect(state.workbenchTabs).not.toContain('preview:/tmp/f0.md');
    expect(state.workbenchTabs).toContain('preview:/tmp/overflow.md');
  });

  it('closePreviewTab removes the corresponding workbench entry', () => {
    const { openPreview, closePreviewTab } = useAppStore.getState();
    openPreview('/tmp/x.md');
    openPreview('/tmp/y.md');
    const xId = useAppStore.getState().previewTabs[0].id;

    closePreviewTab(xId);

    const state = useAppStore.getState();
    expect(state.workbenchTabs).not.toContain('preview:/tmp/x.md');
    expect(state.workbenchTabs).toContain('preview:/tmp/y.md');
  });

  it('closePreview clears all preview entries but leaves pinned tabs intact', () => {
    const { openWorkbenchTab, openPreview, closePreview } = useAppStore.getState();
    openWorkbenchTab('task');
    openWorkbenchTab('files');
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');

    closePreview();

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['overview', 'files']);
    // Active falls back to a pinned tab, not null.
    expect(state.activeWorkbenchTab === 'overview' || state.activeWorkbenchTab === 'files').toBe(true);
  });

  it('auto-opens task workbench only while live activity is present', () => {
    const { syncTaskWorkbenchForActivity } = useAppStore.getState();

    syncTaskWorkbenchForActivity(true);
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview'],
      activeWorkbenchTab: 'overview',
      taskWorkbenchOpenSource: 'auto',
      taskWorkbenchActivityActive: true,
      taskPanelTab: 'monitor',
    });

    syncTaskWorkbenchForActivity(false);
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      taskWorkbenchOpenSource: null,
      taskWorkbenchActivityActive: false,
    });
  });

  it('keeps a manually opened task workbench when activity is absent', () => {
    const { openWorkbenchTab, syncTaskWorkbenchForActivity } = useAppStore.getState();

    openWorkbenchTab('task');
    syncTaskWorkbenchForActivity(false);

    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview'],
      activeWorkbenchTab: 'overview',
      taskWorkbenchOpenSource: 'user',
    });
  });

  it('does not immediately re-open task after the user closes it during the same activity window', () => {
    const { syncTaskWorkbenchForActivity, closeWorkbenchTab } = useAppStore.getState();

    syncTaskWorkbenchForActivity(true);
    closeWorkbenchTab('task');
    syncTaskWorkbenchForActivity(true);

    expect(useAppStore.getState().workbenchTabs).toEqual([]);

    syncTaskWorkbenchForActivity(false);
    syncTaskWorkbenchForActivity(true);

    expect(useAppStore.getState().workbenchTabs).toEqual(['overview']);
  });

  it('setActivePreviewTab also syncs activeWorkbenchTab', () => {
    const { openPreview, setActivePreviewTab } = useAppStore.getState();
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');
    const aId = useAppStore.getState().previewTabs[0].id;

    setActivePreviewTab(aId);

    expect(useAppStore.getState().activeWorkbenchTab).toBe('preview:/tmp/a.md');
  });

  it('opens live URLs in the Browser view and keeps file artifacts in Preview', () => {
    const { openLivePreview, openPreview } = useAppStore.getState();

    openLivePreview('http://127.0.0.1:4173', 'server-1');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['browser'],
      activeWorkbenchTab: 'browser',
    });
    expect(useAppStore.getState().workbenchTabs).not.toContain('preview:http://127.0.0.1:4173');

    openPreview('/tmp/report.pdf');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('preview:/tmp/report.pdf');
    expect(useAppStore.getState().workbenchTabs).toEqual(['browser', 'preview:/tmp/report.pdf']);
  });

});
