import type { PreviewWorkbenchViewId, WorkbenchViewId } from '../utils/workbenchViews';
import type { ContentPreviewInput, PreviewTab } from './appStore';

interface ContentPreviewState {
  previewTabs: PreviewTab[];
  workbenchTabs: WorkbenchViewId[];
}

export function buildContentPreviewState(
  state: ContentPreviewState,
  input: ContentPreviewInput,
  nextTick: () => number,
  maxTabs: number,
): Pick<ContentPreviewState, 'previewTabs' | 'workbenchTabs'> & {
  activePreviewTabId: string;
  activeWorkbenchTab: PreviewWorkbenchViewId;
} {
  const extension = input.format === 'markdown' ? 'md' : input.format === 'text' ? 'txt' : input.format;
  const safeTitle = input.title.replace(/[/\\]/g, '-').trim() || 'artifact';
  const path = `artifact://${encodeURIComponent(input.id)}/${safeTitle}.${extension}`;
  const activeWorkbenchTab: PreviewWorkbenchViewId = `preview:${path}`;
  const existing = state.previewTabs.find((tab) => tab.kind === 'virtual' && tab.path === path);

  if (existing) {
    return {
      activePreviewTabId: existing.id,
      previewTabs: state.previewTabs.map((tab) => tab.id === existing.id
        ? { ...tab, title: input.title, content: input.content, savedContent: input.content, lastActivatedAt: nextTick() }
        : tab),
      workbenchTabs: state.workbenchTabs.includes(activeWorkbenchTab)
        ? state.workbenchTabs
        : [...state.workbenchTabs, activeWorkbenchTab],
      activeWorkbenchTab,
    };
  }

  const tab: PreviewTab = {
    id: `ptab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    path,
    title: input.title,
    content: input.content,
    savedContent: input.content,
    mode: 'preview',
    lastActivatedAt: nextTick(),
    isLoaded: true,
    kind: 'virtual',
  };
  let previewTabs = state.previewTabs;
  let workbenchTabs = state.workbenchTabs;
  if (previewTabs.length >= maxTabs) {
    const oldest = previewTabs.reduce((a, b) => (a.lastActivatedAt <= b.lastActivatedAt ? a : b));
    previewTabs = previewTabs.filter((item) => item.id !== oldest.id);
    workbenchTabs = workbenchTabs.filter((item) => item !== `preview:${oldest.path}`);
  }
  return {
    previewTabs: [...previewTabs, tab],
    activePreviewTabId: tab.id,
    workbenchTabs: [...workbenchTabs, activeWorkbenchTab],
    activeWorkbenchTab,
  };
}
