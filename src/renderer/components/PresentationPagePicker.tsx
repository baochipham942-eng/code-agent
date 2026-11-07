import React, { useEffect, useMemo, useState } from 'react';
import { ImageOff, Loader2, Presentation } from 'lucide-react';
import type {
  PresentationPagePreview,
  PresentationPagePreviewResult,
} from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import { resolveFileUrl } from '../utils/resolveFileUrl';
import { LocalityFeedbackBar } from './LivePreview/LocalityFeedbackBar';
import { useI18n } from '../hooks/useI18n';

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

function missingCopy(
  code: string | undefined,
  design: Pick<ReturnType<typeof useI18n>['t']['design'], 'slidesPreviewMissing' | 'slidesPreviewOffline' | 'slidesPreviewInstallFailed' | 'slidesPreviewUnsupported'>,
): string {
  if (code === 'LIBREOFFICE_RUNTIME_OFFLINE') return design.slidesPreviewOffline;
  if (code === 'LIBREOFFICE_RUNTIME_UNSUPPORTED') return design.slidesPreviewUnsupported;
  if (code?.startsWith('LIBREOFFICE_RUNTIME_')) return design.slidesPreviewInstallFailed;
  return design.slidesPreviewMissing;
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

/**
 * libreoffice-missing 且还没有失败码（安装仍在后台进行）时的有界自动重试节奏：
 * 逐次退避，总和 < 10 分钟；出页图 / 拿到具体失败码 / 换文件 / 卸载即停。
 */
const MISSING_RETRY_DELAYS_MS = [3_000, 7_000, 15_000, 30_000, 60_000, 90_000, 120_000, 150_000];

function shouldRetryMissingPreview(result: PresentationPagePreviewResult): boolean {
  return result.state === 'libreoffice-missing' && result.error === undefined;
}

function outlineText(page: PresentationOutlinePage): string[] {
  if (page.text?.length) return page.text;
  return page.textPreview ? [page.textPreview] : [];
}

export const PresentationPagePicker: React.FC<Props> = ({ title, filePath, outlinePages = [], preview }) => {
  const { t } = useI18n();
  const [resolved, setResolved] = useState<PresentationPagePreviewResult | undefined>(preview);
  const [loading, setLoading] = useState(Boolean(filePath && !preview));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
    if (preview) {
      // 首屏直接画传入的缓存结果（右栏文件预览路径由 PreviewPanel 提供）。
      setResolved(preview);
      setLoading(false);
      setLoadError(null);
      // 缓存结果仍是「LibreOffice 准备中且无失败码」时不短路：继续走下面的
      // 有界自动重试，后台装完即自动出页图，不要求用户手动刷新。
      if (!filePath || !shouldRetryMissingPreview(preview)) return;
    } else if (!filePath) {
      setResolved(undefined);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryIndex = 0;
    const request = (): void => {
      void loadPresentationPreview(filePath)
        .then((result) => {
          if (cancelled) return;
          setResolved(result);
          // 安装仍在后台准备：按有界节奏自动重发一次预览请求，成功出页图或
          // 拿到具体失败码后由条件自然停止。
          if (shouldRetryMissingPreview(result) && retryIndex < MISSING_RETRY_DELAYS_MS.length) {
            retryTimer = setTimeout(request, MISSING_RETRY_DELAYS_MS[retryIndex]);
            retryIndex += 1;
          }
        })
        .catch((error) => {
          if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    if (preview) {
      // 首屏结果已有（缓存 missing）：不立即重发，从第一档退避开始等，
      // 节奏与聊天附件路径一致。
      retryTimer = setTimeout(request, MISSING_RETRY_DELAYS_MS[retryIndex]);
      retryIndex += 1;
    } else {
      setLoading(true);
      setLoadError(null);
      request();
    }
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
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
        <Presentation className="h-4 w-4 text-badge-accent" />
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
        <div className="mt-3 flex items-center gap-2 rounded border border-badge-warning/20 bg-amber-500/[0.05] px-2.5 py-2 text-xs text-badge-warning">
          <ImageOff className="h-3.5 w-3.5 shrink-0" />
          {resolved?.state === 'libreoffice-missing'
            ? missingCopy(resolved.error, t.design)
            : '截图转换失败，已切换为可选文字大纲。'}
        </div>
      )}

      {pages.length > 0 && (
        // 一页一行：整宽大图纵向排列，幻灯片内容可读（此前 2-3 列网格缩略图看不清）
        <div className="mt-3 flex flex-col gap-3">
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
                    ? 'border-badge-info bg-cyan-500/10'
                    : 'border-white/[0.08] bg-zinc-900/70 hover:border-white/[0.18]'
                }`}
              >
                {screenshotsReady && screenshotPath ? (
                  <img
                    src={resolveFileUrl(screenshotPath)}
                    alt={`第 ${displayIndex + 1} 页 · ${pageTitle}`}
                    className="w-full bg-zinc-950 object-contain"
                  />
                ) : (
                  <div className="overflow-hidden p-2 text-[10px] leading-relaxed text-zinc-400">
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
