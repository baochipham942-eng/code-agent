import React, { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Globe2 } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { normalizeBrowserUrl } from '../utils/browserUrl';

const LivePreviewFrame = lazy(() => import('./LivePreview/LivePreviewFrame'));

export const BrowserPreviewPanel: React.FC = () => {
  const { t } = useI18n();
  const previewTabs = useAppStore((state) => state.previewTabs);
  const activePreviewTabId = useAppStore((state) => state.activePreviewTabId);
  const openLivePreview = useAppStore((state) => state.openLivePreview);
  const [urlInput, setUrlInput] = useState('');
  const activeLivePreview = useMemo(
    () => previewTabs.find((tab) => (
      tab.id === activePreviewTabId
      && tab.kind === 'liveDev'
      && Boolean(tab.devServerUrl)
    )) ?? null,
    [activePreviewTabId, previewTabs],
  );
  const handleNavigate = useCallback(() => {
    const normalizedUrl = normalizeBrowserUrl(urlInput);
    if (!normalizedUrl) return;
    openLivePreview(normalizedUrl);
  }, [openLivePreview, urlInput]);

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
        <>
          <form
            className="flex items-center gap-2 border-b border-zinc-700 bg-zinc-800 px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              handleNavigate();
            }}
          >
            <input
              type="text"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                handleNavigate();
              }}
              aria-label={t.workbenchTabs.browserAddressLabel}
              placeholder={t.workbenchTabs.browserAddressPlaceholder}
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-mono text-zinc-300 focus:border-primary-400 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded bg-primary-500 px-3 py-1 text-xs font-medium text-white hover:bg-primary-400"
            >
              {t.workbenchTabs.browserGo}
            </button>
          </form>
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
        </>
      )}
    </div>
  );
};
