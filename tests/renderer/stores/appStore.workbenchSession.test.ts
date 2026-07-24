// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('appStore workbench per-session', () => {
  beforeEach(() => {
    useAppStore.setState({
      previewTabs: [],
      activePreviewTabId: null,
      workbenchTabs: [],
      activeWorkbenchTab: null,
      workbenchBySession: {},
      workbenchSessionKey: null,
    });
  });

  it('snapshots and restores tabs and active view across session switches', () => {
    const store = useAppStore.getState();
    store.syncWorkbenchForSession('session-a');
    store.openWorkbenchTab('overview');
    store.openWorkbenchTab('browser');

    useAppStore.getState().syncWorkbenchForSession('session-b');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      workbenchSessionKey: 'session-b',
    });

    useAppStore.getState().syncWorkbenchForSession('session-a');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview', 'browser'],
      activeWorkbenchTab: 'browser',
      workbenchSessionKey: 'session-a',
    });
  });

  it('filters evicted preview views and falls active back to the first survivor', () => {
    const store = useAppStore.getState();
    store.syncWorkbenchForSession('session-a');
    store.openWorkbenchTab('overview');
    store.openPreview('/tmp/evicted.html');
    store.syncWorkbenchForSession('session-b');

    useAppStore.setState({
      previewTabs: [],
      activePreviewTabId: null,
    });
    useAppStore.getState().syncWorkbenchForSession('session-a');

    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview'],
      activeWorkbenchTab: 'overview',
    });
  });
});
