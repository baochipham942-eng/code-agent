import React, { useEffect, useMemo, useState } from 'react';
import { ImageOff, Loader2, Presentation } from 'lucide-react';
import type {
  PresentationPagePreview,
  PresentationPagePreviewResult,
} from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import { resolveFileUrl } from '../utils/resolveFileUrl';
import { LocalityFeedbackBar } from './LivePreview/LocalityFeedbackBar';

interface PresentationOutlinePage {
  index: number;
  title?: string;
  text?: string[];
  textPreview?: string;
}

interface Props {
  title: string;
  /** 缺绝对本地路径时只展示大纲，不出现反馈入口。 */
  filePath?: string;
  outlinePages?: PresentationOutlinePage[];
  /** Workspace 已经经 IPC 取回数据时直接复用，避免第二次请求。 */
  preview?: PresentationPagePreviewResult;
}

async function loadPresentationPreview(filePath: string): Promise<PresentationPagePreviewResult> {
  const response = await window.domainAPI?.invoke<PresentationPagePreviewResult>(
    IPC_DOMAINS.WORKSPACE,
    'previewPresentation',
    { filePath },
  );
  if (!response?.success || !response.data) {
    throw new Error(response?.error?.message || 'PPT 逐页预览不可用');
  }
  return response.data;
}

function outlineText(page: PresentationOutlinePage): string[] {
  if (page.text?.length) return page.text;
  return page.textPreview ? [page.textPreview] : [];
}

export const PresentationPagePicker: React.FC<Props> = ({ title, filePath, outlinePages = [], preview }) => {
  const [resolved, setResolved] = useState<PresentationPagePreviewResult | undefined>(preview);
  const [loading, setLoading] = useState(Boolean(filePath && !preview));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
    if (preview) {
      setResolved(preview);
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (!filePath) {
      setResolved(undefined);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void loadPresentationPreview(filePath)
      .then((result) => {
        if (!cancelled) setResolved(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filePath, preview]);

  const pages = useMemo(() => {
    if (resolved?.pages.length) return resolved.pages;
    return outlinePages.map((page) => ({
      locator: undefined,
      title: page.title,
      text: outlineText(page),
      displayIndex: Math.max(0, page.index - 1),
    }));
  }, [resolved, outlinePages]);
  const selected = pages[Math.min(selectedIndex, Math.max(0, pages.length - 1))];
  const selectedLocator = selected && 'locator' in selected
    ? selected.locator as PresentationPagePreview['locator'] | undefined
    : undefined;
  const screenshotsReady = resolved?.state === 'ready';

  return (
    <div data-testid="presentation-page-picker" className="w-full max-w-2xl rounded-xl border border-zinc-700 bg-zinc-800/70 p-3">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <Presentation className="h-4 w-4 text-violet-400" />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-200" title={title}>{title}</span>
        <span>{pages.length || outlinePages.length} 页</span>
      </div>

      {loading && (
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在生成逐页预览…
        </div>
      )}

      {(resolved?.state === 'libreoffice-missing' || resolved?.state === 'conversion-failed' || loadError) && (
        <div className="mt-3 flex items-center gap-2 rounded border border-amber-500/20 bg-amber-500/[0.05] px-2.5 py-2 text-xs text-amber-200">
          <ImageOff className="h-3.5 w-3.5 shrink-0" />
          {resolved?.state === 'libreoffice-missing'
            ? '本机没有 LibreOffice，已切换为可选文字大纲。'
            : '截图转换失败，已切换为可选文字大纲。'}
        </div>
      )}

      {pages.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {pages.map((page, index) => {
            const locator = 'locator' in page ? page.locator : undefined;
            const displayIndex = locator?.target.displayIndex ?? ('displayIndex' in page ? page.displayIndex : index);
            const screenshotPath = 'screenshotPath' in page ? page.screenshotPath : undefined;
            const pageTitle = page.title || `第 ${displayIndex + 1} 页`;
            return (
              <button
                key={locator?.target.relationshipId || `${displayIndex}:${pageTitle}`}
                type="button"
                aria-pressed={index === selectedIndex}
                onClick={() => setSelectedIndex(index)}
                className={`overflow-hidden rounded-md border text-left transition-colors ${
                  index === selectedIndex
                    ? 'border-cyan-400 bg-cyan-500/10'
                    : 'border-white/[0.08] bg-zinc-900/70 hover:border-white/[0.18]'
                }`}
              >
                {screenshotsReady && screenshotPath ? (
                  <img
                    src={resolveFileUrl(screenshotPath)}
                    alt={`第 ${displayIndex + 1} 页 · ${pageTitle}`}
                    className="aspect-video w-full bg-zinc-950 object-cover"
                  />
                ) : (
                  <div className="aspect-video overflow-hidden p-2 text-[10px] leading-relaxed text-zinc-400">
                    {page.text.slice(0, 5).join(' · ') || '本页没有可读取文字'}
                  </div>
                )}
                <div className="border-t border-white/[0.06] px-2 py-1.5 text-[11px] text-zinc-300">
                  第 {displayIndex + 1} 页 · {pageTitle}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedLocator && (
        <div className="mt-3">
          <LocalityFeedbackBar
            locator={selectedLocator}
            locationLabel={`第 ${selectedLocator.target.displayIndex + 1} 页`}
          />
        </div>
      )}
    </div>
  );
};
