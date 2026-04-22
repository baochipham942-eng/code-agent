import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore, MAX_PREVIEW_TABS } from '../../../src/renderer/stores/appStore';

describe('appStore workbench tabs', () => {
  beforeEach(() => {
    // Reset: close all preview tabs, put only 'task' pinned, activate it.
    useAppStore.getState().closePreview();
    useAppStore.setState({
      workbenchTabs: ['task'],
      activeWorkbenchTab: 'task',
    });
  });

  it('has task pinned and active by default', () => {
    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task']);
    expect(state.activeWorkbenchTab).toBe('task');
  });

  it('openWorkbenchTab appends a new tab and activates it', () => {
    useAppStore.getState().openWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task', 'skills']);
    expect(state.activeWorkbenchTab).toBe('skills');
  });

  it('openWorkbenchTab on an already-open tab only re-activates (no duplicate)', () => {
    const { openWorkbenchTab, setActiveWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('skills');
    setActiveWorkbenchTab('task');

    openWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task', 'skills']);
    expect(state.activeWorkbenchTab).toBe('skills');
  });

  it('closeWorkbenchTab removes tab and clears active when nothing remains', () => {
    const { closeWorkbenchTab } = useAppStore.getState();
    closeWorkbenchTab('task');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual([]);
    expect(state.activeWorkbenchTab).toBeNull();
  });

  it('closeWorkbenchTab on active falls back to another pinned tab', () => {
    const { openWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('skills');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('skills');

    closeWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task']);
    expect(state.activeWorkbenchTab).toBe('task');
  });

  it('closeWorkbenchTab on a non-active tab leaves active alone', () => {
    const { openWorkbenchTab, setActiveWorkbenchTab, closeWorkbenchTab } = useAppStore.getState();
    openWorkbenchTab('skills');
    setActiveWorkbenchTab('task');

    closeWorkbenchTab('skills');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task']);
    expect(state.activeWorkbenchTab).toBe('task');
  });

  it('closeWorkbenchTab on active preview prefers the most-recent remaining preview', () => {
    const { openPreview, setActivePreviewTab, closeWorkbenchTab } = useAppStore.getState();
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');
    openPreview('/tmp/c.md');
    const { previewTabs } = useAppStore.getState();
    const aId = previewTabs[0].id;
    const bId = previewTabs[1].id;
    const cId = previewTabs[2].id;
    // Make 'b' the most-recently-activated among {a, b}.
    setActivePreviewTab(aId);
    setActivePreviewTab(bId);
    setActivePreviewTab(cId);
    expect(useAppStore.getState().activeWorkbenchTab).toBe('preview:/tmp/c.md');

    closeWorkbenchTab('preview:/tmp/c.md');

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toContain('preview:/tmp/b.md');
    expect(state.workbenchTabs).not.toContain('preview:/tmp/c.md');
    expect(state.activeWorkbenchTab).toBe('preview:/tmp/b.md');
    // previewTabs unaffected — workbench tab close does not delete the preview entry.
    expect(state.previewTabs.map((t) => t.id)).toEqual([aId, bId, cId]);
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
    setActiveWorkbenchTab('task');

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
    openWorkbenchTab('skills');
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');

    closePreview();

    const state = useAppStore.getState();
    expect(state.workbenchTabs).toEqual(['task', 'skills']);
    // Active falls back to a pinned tab, not null.
    expect(state.activeWorkbenchTab === 'task' || state.activeWorkbenchTab === 'skills').toBe(true);
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
