import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore, MAX_PREVIEW_TABS } from '../../../src/renderer/stores/appStore';

describe('appStore preview tabs', () => {
  beforeEach(() => {
    // Reset preview state between tests
    useAppStore.getState().closePreview();
  });

  it('openPreview creates a new tab when path is not open', () => {
    useAppStore.getState().openPreview('/tmp/a.md');

    const state = useAppStore.getState();
    expect(state.previewTabs).toHaveLength(1);
    expect(state.previewTabs[0].path).toBe('/tmp/a.md');
    expect(state.activePreviewTabId).toBe(state.previewTabs[0].id);
    expect(state.showPreviewPanel).toBe(true);
    expect(state.previewTabs[0].isLoaded).toBe(false);
  });

  it('openPreview with the same path activates existing tab, no duplicate', () => {
    const { openPreview } = useAppStore.getState();
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');
    const firstId = useAppStore.getState().previewTabs[0].id;

    openPreview('/tmp/a.md');

    const state = useAppStore.getState();
    expect(state.previewTabs).toHaveLength(2);
    expect(state.activePreviewTabId).toBe(firstId);
  });

  it('openPreview evicts the least-recently-activated tab when at capacity', () => {
    const { openPreview, setActivePreviewTab } = useAppStore.getState();
    for (let i = 0; i < MAX_PREVIEW_TABS; i++) {
      openPreview(`/tmp/f${i}.md`);
    }
    // First tab is now the oldest (lastActivatedAt set when opened).
    // Touch the second tab so the FIRST one becomes the eviction target.
    const firstId = useAppStore.getState().previewTabs[0].id;
    const secondId = useAppStore.getState().previewTabs[1].id;
    setActivePreviewTab(secondId);

    openPreview('/tmp/overflow.md');

    const state = useAppStore.getState();
    expect(state.previewTabs).toHaveLength(MAX_PREVIEW_TABS);
    expect(state.previewTabs.find((t) => t.id === firstId)).toBeUndefined();
    expect(state.previewTabs.at(-1)?.path).toBe('/tmp/overflow.md');
  });

  it('closePreviewTab on active picks the most-recently-activated survivor', () => {
    const { openPreview, setActivePreviewTab, closePreviewTab } = useAppStore.getState();
    openPreview('/tmp/a.md');
    openPreview('/tmp/b.md');
    openPreview('/tmp/c.md');
    // Touch b so it's the most-recently-active among {a, b}
    const aId = useAppStore.getState().previewTabs[0].id;
    const bId = useAppStore.getState().previewTabs[1].id;
    const cId = useAppStore.getState().previewTabs[2].id;
    setActivePreviewTab(aId);
    setActivePreviewTab(bId);
    setActivePreviewTab(cId);

    closePreviewTab(cId);

    const state = useAppStore.getState();
    expect(state.previewTabs).toHaveLength(2);
    expect(state.activePreviewTabId).toBe(bId);
  });

  it('closePreviewTab on last tab hides the panel', () => {
    const { openPreview, closePreviewTab } = useAppStore.getState();
    openPreview('/tmp/only.md');
    const onlyId = useAppStore.getState().previewTabs[0].id;

    closePreviewTab(onlyId);

    const state = useAppStore.getState();
    expect(state.previewTabs).toHaveLength(0);
    expect(state.activePreviewTabId).toBeNull();
    expect(state.showPreviewPanel).toBe(false);
  });

  it('markPreviewTabLoaded populates content and savedContent together', () => {
    const { openPreview, markPreviewTabLoaded } = useAppStore.getState();
    openPreview('/tmp/a.md');
    const id = useAppStore.getState().previewTabs[0].id;

    markPreviewTabLoaded(id, '# hello');

    const tab = useAppStore.getState().previewTabs[0];
    expect(tab.content).toBe('# hello');
    expect(tab.savedContent).toBe('# hello');
    expect(tab.isLoaded).toBe(true);
  });

  it('markPreviewTabSaved copies content into savedContent, clearing dirty', () => {
    const { openPreview, markPreviewTabLoaded, updatePreviewTabContent, markPreviewTabSaved } = useAppStore.getState();
    openPreview('/tmp/a.md');
    const id = useAppStore.getState().previewTabs[0].id;
    markPreviewTabLoaded(id, 'v1');
    updatePreviewTabContent(id, 'v2 draft');
    expect(useAppStore.getState().previewTabs[0].savedContent).toBe('v1');

    markPreviewTabSaved(id);

    const tab = useAppStore.getState().previewTabs[0];
    expect(tab.savedContent).toBe('v2 draft');
    expect(tab.content).toBe(tab.savedContent);
  });
});
