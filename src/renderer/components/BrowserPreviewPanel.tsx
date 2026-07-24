import React, { Suspense, lazy, useMemo } from 'react';
import { Globe2 } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';

const LivePreviewFrame = lazy(() => import('./LivePreview/LivePreviewFrame'));

export const BrowserPreviewPanel: React.FC = () => {
  const { t } = useI18n();
  const previewTabs = useAppStore((state) => state.previewTabs);
  const activePreviewTabId = useAppStore((state) => state.activePreviewTabId);
  const activeLivePreview = useMemo(
    () => previewTabs.find((tab) => (
      tab.id === activePreviewTabId
      && tab.kind === 'liveDev'
      && Boolean(tab.devServerUrl)
    )) ?? null,
    [activePreviewTabId, previewTabs],
  );

  return (
    <div
      data-testid="workbench-browser-view"
      className="flex h-full min-h-0 w-full flex-col bg-zinc-900"
    >
      {activeLivePreview?.devServerUrl ? (
        <Suspense
          fallback={(
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
              {t.previewWorkspace.preview.loadingLivePreview}
            </div>
          )}
        >
          <LivePreviewFrame
            key={`${activeLivePreview.id}:${activeLivePreview.devServerUrl}`}
            tabId={activeLivePreview.id}
            devServerUrl={activeLivePreview.devServerUrl}
          />
        </Suspense>
      ) : (
        <div
          data-testid="workbench-browser-empty"
          className="flex flex-1 items-center justify-center px-6 text-center"
        >
          <div>
            <Globe2 className="mx-auto h-8 w-8 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">{t.workbenchTabs.browserEmpty}</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              {t.workbenchTabs.browserEmptyHint}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
