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
    });
  });

  it('starts with the workbench collapsed by default', () => {
    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual([]);
    expect(state.activeWorkbenchTab).toBeNull();
  });

  it('openWorkbenchTab appends a new tab and activates it', () => {
    useAppStore.getState().openWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['skills']);
    expect(state.activeWorkbenchTab).toBe('skills');
  });

  it('openWorkbenchTab supports the replay audit tab', () => {
    useAppStore.getState().openWorkbenchTab('audit');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['audit']);
    expect(state.activeWorkbenchTab).toBe('audit');
  });

  it('openWorkbenchTab on an already-open tab only re-activates (no duplicate)', () => {
    const { openWorkbenchTab, setActiveWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('task');
    openWorkbenchTab('skills');
    setActiveWorkbenchTab('task');

    openWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task', 'skills']);
    expect(state.activeWorkbenchTab).toBe('skills');
  });

  it('openWorkspacePreview opens the workspace preview tab and tracks selected item', () => {
    useAppStore.getState().openWorkspacePreview('preview-item-1');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['workspace-preview']);
    expect(state.activeWorkbenchTab).toBe('workspace-preview');
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
    openWorkbenchTab('skills');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('skills');

    closeWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task']);
    expect(state.activeWorkbenchTab).toBe('task');
  });

  it('closeWorkbenchTab on a non-active tab leaves active alone', () => {
    const { openWorkbenchTab, setActiveWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('task');
    openWorkbenchTab('skills');
    setActiveWorkbenchTab('task');

    closeWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task']);
    expect(state.activeWorkbenchTab).toBe('task');
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
    useAppStore.getState().openWorkbenchTab('skills');
    setActiveWorkbenchTab('skills');

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
    openWorkbenchTab('skills');
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');

    closePreview();

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task', 'skills']);
    // Active falls back to a pinned tab, not null.
    expect(state.activeWorkbenchTab === 'task' || state.activeWorkbenchTab === 'skills').toBe(true);
  });

  it('auto-opens task workbench only while live activity is present', () => {
    const { syncTaskWorkbenchForActivity } = useAppStore.getState();

    syncTaskWorkbenchForActivity(true);
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['task'],
      activeWorkbenchTab: 'task',
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
      workbenchTabs: ['task'],
      activeWorkbenchTab: 'task',
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

    expect(useAppStore.getState().workbenchTabs).toEqual(['task']);
  });

  it('setActivePreviewTab also syncs activeWorkbenchTab', () => {
    const { openPreview, setActivePreviewTab } = useAppStore.getState();
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');
    const aId = useAppStore.getState().previewTabs[0].id;

    setActivePreviewTab(aId);

    expect(useAppStore.getState().activeWorkbenchTab).toBe('preview:/tmp/a.md');
  });

});
