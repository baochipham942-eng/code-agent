import { beforeEach, describe, expect, it } from 'vitest';
import { useExplorerStore } from '../../../src/renderer/stores/explorerStore';

describe('explorerStore.openOrFocusTab', () => {
  beforeEach(() => {
    useExplorerStore.getState().reset();
  });

  it('creates a new tab when rootPath is not open', () => {
    const { openOrFocusTab } = useExplorerStore.getState();
    openOrFocusTab('/tmp/a', 'a');

    const { tabs, activeTabId } = useExplorerStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].rootPath).toBe('/tmp/a');
    expect(tabs[0].label).toBe('a');
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('activates existing tab without duplicating when rootPath matches', () => {
    const { openOrFocusTab } = useExplorerStore.getState();
    openOrFocusTab('/tmp/a', 'a');
    openOrFocusTab('/tmp/b', 'b');
    const tabAId = useExplorerStore.getState().tabs[0].id;

    // Switch back to /tmp/a — should focus existing, not add a third tab
    openOrFocusTab('/tmp/a', 'a');

    const { tabs, activeTabId } = useExplorerStore.getState();
    expect(tabs).toHaveLength(2);
    expect(activeTabId).toBe(tabAId);
  });

  it('is a no-op when rootPath already matches the active tab', () => {
    const { openOrFocusTab } = useExplorerStore.getState();
    openOrFocusTab('/tmp/a', 'a');
    const stateBefore = useExplorerStore.getState();

    openOrFocusTab('/tmp/a', 'a');

    const stateAfter = useExplorerStore.getState();
    expect(stateAfter.tabs).toBe(stateBefore.tabs);
    expect(stateAfter.activeTabId).toBe(stateBefore.activeTabId);
  });

  it('keeps previously opened tabs when adding a new one', () => {
    const { openOrFocusTab } = useExplorerStore.getState();
    openOrFocusTab('/tmp/a', 'a');
    openOrFocusTab('/tmp/b', 'b');
    openOrFocusTab('/tmp/c', 'c');

    const { tabs, activeTabId } = useExplorerStore.getState();
    expect(tabs.map((t) => t.rootPath)).toEqual(['/tmp/a', '/tmp/b', '/tmp/c']);
    expect(activeTabId).toBe(tabs[2].id);
  });
});
