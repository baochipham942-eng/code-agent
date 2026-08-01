import React from 'react';
import { useAppStore, type WorkbenchViewId } from '../stores/appStore';
import { isPreviewWorkbenchView } from '../utils/workbenchViews';
import { useI18n } from '../hooks/useI18n';
import { BrowserAgentWindow } from './workbench/BrowserAgentWindow';
import { PreviewPanel } from './PreviewPanel';
import { WorkbenchOverview } from './WorkbenchOverview';
import { FileExplorerPanel } from './features/explorer/FileExplorerPanel';

const DesignCanvasTab = React.lazy(() => import('./design/DesignCanvasTab').then((module) => ({
  default: module.DesignCanvasTab,
})));
// S2 归位：liveDev 预览不再借用 'browser' 视图，改与文件预览同住 `preview:*`——
// 这里按 activeTab.kind 分流到 LivePreviewFrame（直连 iframe/bridge，无文件工具栏）。
const LivePreviewFrame = React.lazy(() => import('./LivePreview/LivePreviewFrame'));

export interface WorkbenchViewContentProps {
  activeView: WorkbenchViewId | null;
  onCloseFiles: () => void;
}

export const WorkbenchViewContent: React.FC<WorkbenchViewContentProps> = ({
  activeView,
  onCloseFiles,
}) => {
  const { t } = useI18n();
  // 与 PreviewPanel 同一模式：只从 store 选原始字段（引用稳定），派生对象在
  // useMemo 里算——selector 直接 return 新对象会让 zustand 每帧判定"变了"，
  // 触发 useSyncExternalStore 无限重渲染（React "Maximum update depth exceeded"）。
  const previewTabs = useAppStore((state) => state.previewTabs);
  const activePreviewTabId = useAppStore((state) => state.activePreviewTabId);
  const activeLiveDevTab = React.useMemo(() => {
    const tab = previewTabs.find((candidate) => candidate.id === activePreviewTabId);
    if (!tab || tab.kind !== 'liveDev' || !tab.devServerUrl) return null;
    return { id: tab.id, devServerUrl: tab.devServerUrl };
  }, [previewTabs, activePreviewTabId]);

  if (activeView === 'overview') {
    return <WorkbenchOverview />;
  }
  if (activeView === 'files') {
    return (
      <div data-testid="workbench-files-view" className="h-full min-h-0">
        <FileExplorerPanel onClose={onCloseFiles} />
      </div>
    );
  }
  if (activeView === 'browser') {
    return <BrowserAgentWindow />;
  }
  if (activeView === 'design-canvas') {
    return (
      <div data-testid="workbench-canvas-view" className="h-full min-h-0">
        <React.Suspense fallback={null}>
          <DesignCanvasTab />
        </React.Suspense>
      </div>
    );
  }
  if (isPreviewWorkbenchView(activeView)) {
    return (
      <div data-testid="workbench-preview-view" className="h-full min-h-0">
        {activeLiveDevTab ? (
          <React.Suspense
            fallback={(
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                {t.previewWorkspace.preview.loadingLivePreview}
              </div>
            )}
          >
            <LivePreviewFrame
              key={`${activeLiveDevTab.id}:${activeLiveDevTab.devServerUrl}`}
              tabId={activeLiveDevTab.id}
              devServerUrl={activeLiveDevTab.devServerUrl}
            />
          </React.Suspense>
        ) : (
          <PreviewPanel />
        )}
      </div>
    );
  }
  return null;
};
