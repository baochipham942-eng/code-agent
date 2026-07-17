import React from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  Folder,
  Maximize2,
  X,
} from 'lucide-react';
import {
  estimateDataUrlBytes,
  LARGE_INLINE_MEDIA_BYTES,
  type SessionMediaAsset,
} from '@shared/utils/sessionMediaAssets';
import { IPC_DOMAINS } from '@shared/ipc';
import { resolveFileUrl } from '../../../../utils/resolveFileUrl';
import { copyPathToClipboard, isWebMode } from '../../../../utils/platform';

export type MediaAssetAction = 'copy' | 'open' | 'save' | 'reveal' | 'lightbox';

export function getMediaAssetFileName(asset: SessionMediaAsset): string {
  if (asset.filename) return asset.filename;
  const source = asset.path || asset.url;
  if (!source) return asset.kind === 'video' ? 'video.mp4' : asset.kind === 'audio' ? 'audio' : 'image.png';
  return source.split(/[?#]/, 1)[0]?.split('/').filter(Boolean).pop() || source;
}

function labelFromMediaRef(ref: string): string {
  const value = ref.replace(/^(path|url|data|thumb):/i, '');
  const clean = value.split(/[?#]/, 1)[0] || value;
  return clean.split('/').filter(Boolean).pop() || value;
}

export function getMediaAssetParentLabels(asset: SessionMediaAsset): string[] {
  return Array.from(new Set((asset.parentAssetIds || []).map(labelFromMediaRef)));
}

export function getMediaAssetSourceLabels(asset: SessionMediaAsset): string[] {
  return Array.from(new Set(asset.sources.map((source) => {
    const label = source.label
      || source.attachmentId
      || source.toolCallId
      || source.artifactId
      || source.messageId
      || source.turnId;
    switch (source.source) {
      case 'attachment':
        return label ? `附件 ${label}` : '附件';
      case 'markdown':
        return label ? `正文 ${label}` : '正文图片';
      case 'tool_result':
        return label ? `工具 ${label}` : '工具结果';
      case 'artifact':
        return label ? `输出 ${label}` : '输出文件';
      default:
        return label || source.source;
    }
  })));
}

export function getRenderableMediaSrc(asset: SessionMediaAsset): string {
  if (asset.path) return resolveFileUrl(asset.path);
  if (asset.url) return asset.url;
  if (asset.largeInlineData) {
    const thumbnailBytes = estimateDataUrlBytes(asset.thumbnailUrl);
    const hasLightweightThumbnail = Boolean(asset.thumbnailUrl)
      && asset.thumbnailUrl !== asset.dataUrl
      && (thumbnailBytes === undefined || thumbnailBytes <= LARGE_INLINE_MEDIA_BYTES);
    return hasLightweightThumbnail ? asset.thumbnailUrl || '' : '';
  }
  if (asset.dataUrl) return asset.dataUrl;
  return asset.thumbnailUrl || '';
}

function getCopyReference(asset: SessionMediaAsset): string {
  if (asset.largeInlineData && !asset.path && !asset.url) {
    return getMediaAssetFileName(asset);
  }
  return asset.path || asset.url || asset.dataUrl || asset.thumbnailUrl || getMediaAssetFileName(asset);
}

export function getMediaAssetAvailableActions(
  asset: SessionMediaAsset,
  options: { hasLightbox?: boolean } = {},
): MediaAssetAction[] {
  const hasRenderableSource = Boolean(getRenderableMediaSrc(asset));
  const actions: MediaAssetAction[] = ['copy'];
  if (options.hasLightbox && hasRenderableSource) actions.push('lightbox');
  if (hasRenderableSource) actions.push('open', 'save');
  if (asset.path) actions.push('reveal');
  return actions;
}

const SOURCE_LABELS: Record<SessionMediaAsset['source'], string> = {
  attachment: '附件',
  markdown: '正文图片',
  tool_result: '工具结果',
  artifact: '输出文件',
};

export function getMediaAssetSourceSummary(asset: SessionMediaAsset): string {
  const sourceLabels = Array.from(new Set(asset.sources.map((source) => SOURCE_LABELS[source.source])));
  const sourceText = sourceLabels.length ? sourceLabels.join(' / ') : SOURCE_LABELS[asset.source];
  const parentText = asset.parentAssetIds?.length ? ` · ${asset.parentAssetIds.length} 个输入素材` : '';
  const stateText = asset.state === 'failed' ? ' · 失败' : asset.state === 'pending' ? ' · 生成中' : '';
  return `${sourceText}${parentText}${stateText}`;
}

async function openMediaAsset(asset: SessionMediaAsset): Promise<void> {
  if (asset.path) {
    if (isWebMode()) {
      await copyPathToClipboard(asset.path);
      return;
    }
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'openPath', {
      filePath: asset.path,
    });
    return;
  }

  const src = getRenderableMediaSrc(asset);
  if (src) {
    window.open(src, '_blank');
  }
}

async function revealMediaAsset(asset: SessionMediaAsset): Promise<void> {
  if (!asset.path) return;
  if (isWebMode()) {
    await copyPathToClipboard(asset.path);
    return;
  }
  await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', {
    filePath: asset.path,
  });
}

async function saveMediaAsset(asset: SessionMediaAsset): Promise<void> {
  const fileName = getMediaAssetFileName(asset);
  const src = getRenderableMediaSrc(asset);
  if (!src) return;

  if (asset.path && isWebMode()) {
    await copyPathToClipboard(asset.path);
    return;
  }

  if (asset.url && /^https?:\/\//i.test(asset.url) && !isWebMode()) {
    const response = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'downloadFile', {
      url: asset.url,
      filename: fileName,
    });
    const filePath = (response?.data as { filePath?: string } | undefined)?.filePath;
    if (filePath) {
      await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', { filePath });
      return;
    }
  }

  const link = document.createElement('a');
  link.href = src;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function MediaAssetActionBar({
  asset,
  onOpenLightbox,
  compact = false,
}: {
  asset: SessionMediaAsset;
  onOpenLightbox?: () => void;
  compact?: boolean;
}) {
  const actions = getMediaAssetAvailableActions(asset, { hasLightbox: Boolean(onOpenLightbox) });
  const hasAction = (action: MediaAssetAction) => actions.includes(action);
  const buttonClass = compact
    ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-700/70 hover:text-zinc-100'
    : 'inline-flex items-center gap-1 rounded-md bg-zinc-800/70 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100';

  return (
    <span
      className="flex flex-wrap items-center gap-1"
      data-media-asset-id={asset.assetId}
      data-media-session-id={asset.sessionId}
      data-media-turn-id={asset.turnId}
      data-media-message-id={asset.messageId}
      data-media-tool-call-id={asset.toolCallId}
    >
      {onOpenLightbox && hasAction('lightbox') && (
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation();
            onOpenLightbox();
          }}
          title="放大查看"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {!compact && <span>查看</span>}
        </button>
      )}
      <button
        type="button"
        className={buttonClass}
        onClick={(event) => {
          event.stopPropagation();
          void copyPathToClipboard(getCopyReference(asset));
        }}
        title="复制引用"
      >
        <Copy className="h-3.5 w-3.5" />
        {!compact && <span>复制</span>}
      </button>
      {hasAction('open') && (
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation();
            void openMediaAsset(asset);
          }}
          title="打开"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {!compact && <span>打开</span>}
        </button>
      )}
      {hasAction('save') && (
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation();
            void saveMediaAsset(asset);
          }}
          title="保存"
        >
          <Download className="h-3.5 w-3.5" />
          {!compact && <span>保存</span>}
        </button>
      )}
      {hasAction('reveal') && (
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation();
            void revealMediaAsset(asset);
          }}
          title="在 Finder 中显示"
        >
          <Folder className="h-3.5 w-3.5" />
          {!compact && <span>Finder</span>}
        </button>
      )}
    </span>
  );
}

export function MediaAssetLightbox({
  asset,
  onClose,
}: {
  asset: SessionMediaAsset;
  onClose: () => void;
}) {
  const src = getRenderableMediaSrc(asset);
  const fileName = getMediaAssetFileName(asset);
  const sourceSummary = getMediaAssetSourceSummary(asset);
  const parentLabels = getMediaAssetParentLabels(asset);
  const sourceLabels = getMediaAssetSourceLabels(asset);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      data-media-asset-id={asset.assetId}
      data-media-session-id={asset.sessionId}
      data-media-turn-id={asset.turnId}
      data-media-message-id={asset.messageId}
      data-media-tool-call-id={asset.toolCallId}
      role="dialog"
      aria-modal="true"
      aria-label={fileName}
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-6xl flex-col gap-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 rounded-lg border border-border-muted bg-zinc-950/80 px-3 py-2 shadow-xl">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-zinc-100" title={fileName}>
              {fileName}
            </div>
            <div className="truncate text-xs text-zinc-500">{sourceSummary}</div>
            {sourceLabels.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
                <span className="shrink-0">来源</span>
                {sourceLabels.map((label) => (
                  <span
                    key={label}
                    className="max-w-40 truncate rounded border border-border-muted bg-surface-hover px-1.5 py-0.5 text-zinc-300"
                    title={label}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
            {parentLabels.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
                <span className="shrink-0">输入素材</span>
                {parentLabels.map((label) => (
                  <span
                    key={label}
                    className="max-w-40 truncate rounded border border-border-muted bg-surface-hover px-1.5 py-0.5 text-zinc-300"
                    title={label}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
          <MediaAssetActionBar asset={asset} compact />
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {!src ? (
            <div className="rounded-lg border border-border-muted bg-zinc-950/90 px-4 py-3 text-sm text-zinc-400 shadow-2xl">
              内联媒体过大，已跳过预览
            </div>
          ) : asset.kind === 'video' ? (
            <video
              src={src}
              controls
              className="max-h-[calc(100vh-7rem)] max-w-full rounded-lg bg-black shadow-2xl"
            />
          ) : asset.kind === 'audio' ? (
            <div className="w-full max-w-xl rounded-lg border border-border-muted bg-zinc-950/90 p-4">
              <audio src={src} controls className="w-full" />
            </div>
          ) : (
            <img
              src={src}
              alt={fileName}
              className="max-h-[calc(100vh-7rem)] max-w-full rounded-lg object-contain shadow-2xl"
            />
          )}
        </div>
      </div>
    </div>
  );
}
