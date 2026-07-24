import React from 'react';
import type { WorkbenchViewId } from '../stores/appStore';
import { isPreviewWorkbenchView } from '../utils/workbenchViews';
import { BrowserPreviewPanel } from './BrowserPreviewPanel';
import { PreviewPanel } from './PreviewPanel';
import { WorkbenchOverview } from './WorkbenchOverview';
import { FileExplorerPanel } from './features/explorer/FileExplorerPanel';

const DesignCanvasTab = React.lazy(() => import('./design/DesignCanvasTab').then((module) => ({
  default: module.DesignCanvasTab,
})));

export interface WorkbenchViewContentProps {
  activeView: WorkbenchViewId | null;
  onCloseFiles: () => void;
}

export const WorkbenchViewContent: React.FC<WorkbenchViewContentProps> = ({
  activeView,
  onCloseFiles,
}) => {
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
    return <BrowserPreviewPanel />;
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
        <PreviewPanel />
      </div>
    );
  }
  return null;
};
