import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  Folder,
  Maximize2,
  MoreHorizontal,
  Pencil,
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
import { importAssetToCanvas } from '../../../design/importAssetToCanvas';
import { useAppStore } from '../../../../stores/appStore';
import { toast } from '../../../../hooks/useToast';

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

/**
 * 复制图片本体到剪贴板（2026-08-05 产品负责人：「复制图片却是复制的图片地址」）。
 * ClipboardItem 只稳定支持 image/png，非 png 经 canvas 转码；任何一步失败返回 false，
 * 调用方兜底回退复制引用（路径），不静默。
 */
async function copyImageToClipboard(asset: SessionMediaAsset): Promise<boolean> {
  const src = getRenderableMediaSrc(asset);
  if (!src || asset.kind !== 'image' || typeof ClipboardItem === 'undefined') return false;
  try {
    const response = await fetch(src);
    if (!response.ok) return false;
    let blob = await response.blob();
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) return false;
      blob = png;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
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

/**
 * 「修改」（2026-08-01 B3）：把这张图落进设计画布并选中，然后切到设计画布 tab——
 * 顶栏直接就是那条图像动词条（批注重绘/局部重绘/调整大小/扩图）。
 *
 * 在此之前图产物下面五个按钮全是只读动作（查看/复制/打开/保存/Finder），
 * 没有任何一条能「再改一版」，用户必须自己知道有设计画布这个 tab、自己切过去、自己把图弄进去。
 */
async function editMediaAssetInCanvas(asset: SessionMediaAsset): Promise<void> {
  if (!asset.path) return;
  const r = await importAssetToCanvas(asset.path);
  if (!r.ok) {
    // 失败要说人话且看得见——不能静默什么都不发生（用户会以为按钮坏了）。
    toast.error(r.error ?? '把图放进画布失败');
    return;
  }
  useAppStore.getState().openWorkbenchTab('design-canvas');
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

// 恒进 ⋯ 的动作（菜单里的显示顺序）。
// 「修改」「复制」不在此列：产品负责人拍板的两个常驻主动作，永远直接露在条上。
type MediaAssetOverflowId = 'lightbox' | 'open' | 'save' | 'reveal';
export const MEDIA_ASSET_OVERFLOW_IDS: readonly MediaAssetOverflowId[] = [
  'lightbox',
  'open',
  'save',
  'reveal',
];

export function MediaAssetActionBar({
  asset,
  onOpenLightbox,
  compact = false,
}: {
  asset: SessionMediaAsset;
  onOpenLightbox?: () => void;
  compact?: boolean;
}) {
  const buttonClass = compact
    ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-700/70 hover:text-zinc-100'
    : 'inline-flex items-center gap-1 rounded-md bg-zinc-800/70 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100';

  // B3（2026-08-02 产品负责人拍板）：**固定规则，不做宽度自适应**——
  // 默认只露「修改 + 复制」，查看/打开/保存/Finder 恒进 ⋯。
  // 为什么不用 useToolbarOverflow：这条按钮组全部 10 个调用点都传 compact，
  // 渲染出来是 28px 纯图标，6 个连间距才 ~188px，任何气泡都放得下——
  // 「按实测宽度折叠」在这里会退化成「永不折叠」，等于拍板没落地（实拍验证过）。
  // 宽度自适应留给带文字标签的工具条（DesignImageToolbar / DiagramToolbar），那里标签是真占宽。
  const rootRef = useRef<HTMLSpanElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const itemIds = useMemo<readonly MediaAssetOverflowId[]>(() => {
    const available = getMediaAssetAvailableActions(asset, { hasLightbox: Boolean(onOpenLightbox) });
    return MEDIA_ASSET_OVERFLOW_IDS.filter((id) => available.includes(id));
  }, [asset, onOpenLightbox]);

  // 恒定折叠：可折叠域里在场的项全部进 ⋯。
  const overflowed = useMemo(() => new Set<MediaAssetOverflowId>(itemIds), [itemIds]);

  // 外点关菜单（document 级监听，不铺全屏背板，避免 handrolled-modal 门）。
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [moreOpen]);

  // 一个可折叠项都没有时 ⋯ 不渲染，菜单跟着关（如纯 dataURL 资产只有复制可用）。
  useEffect(() => {
    if (overflowed.size === 0) setMoreOpen(false);
  }, [overflowed]);

  const OVERFLOW_META: Record<
    MediaAssetOverflowId,
    { icon: React.ReactNode; menuIcon: React.ReactNode; label: string; title: string; run: () => void }
  > = {
    lightbox: {
      icon: <Maximize2 className="h-3.5 w-3.5" />,
      menuIcon: <Maximize2 className="h-3.5 w-3.5 text-zinc-500" />,
      label: '查看',
      title: '放大查看',
      run: () => onOpenLightbox?.(),
    },
    open: {
      icon: <ExternalLink className="h-3.5 w-3.5" />,
      menuIcon: <ExternalLink className="h-3.5 w-3.5 text-zinc-500" />,
      label: '打开',
      title: '打开',
      run: () => void openMediaAsset(asset),
    },
    save: {
      icon: <Download className="h-3.5 w-3.5" />,
      menuIcon: <Download className="h-3.5 w-3.5 text-zinc-500" />,
      label: '保存',
      title: '保存',
      run: () => void saveMediaAsset(asset),
    },
    reveal: {
      icon: <Folder className="h-3.5 w-3.5" />,
      menuIcon: <Folder className="h-3.5 w-3.5 text-zinc-500" />,
      label: 'Finder',
      title: '在 Finder 中显示',
      run: () => void revealMediaAsset(asset),
    },
  };

  return (
    // whitespace-nowrap + 各段 shrink-0：这条恒为一排，不许 flex 挤压或折行。
    // min-w-0：Lightbox 顶栏里这条是 flex item，默认 min-width:auto 会把兄弟元素顶宽。
    <span
      ref={rootRef}
      className="flex min-w-0 items-center gap-1 whitespace-nowrap"
      data-media-asset-id={asset.assetId}
      data-media-session-id={asset.sessionId}
      data-media-turn-id={asset.turnId}
      data-media-message-id={asset.messageId}
      data-media-tool-call-id={asset.toolCallId}
    >
      {/* 常驻段：修改/复制 —— 拍板的两个主动作，任何宽度下都在场。 */}
      <span className="flex shrink-0 items-center gap-1">
        {asset.kind === 'image' && !!asset.path && (
          // ds-allow:start 与同一条按钮组里既有的五个只读动作按钮（查看/复制/打开/保存/Finder）同款裸 button + buttonClass，单独换 primitive 会在同一行里高低宽窄不齐；这条按钮组整体迁 primitive 时一并处理
          <button
            type="button"
            className={`${buttonClass} text-badge-accent`}
            onClick={(event) => {
              event.stopPropagation();
              void editMediaAssetInCanvas(asset);
            }}
            title="在设计画布里修改"
            data-testid="media-asset-edit-in-canvas"
          >
            <Pencil className="h-3.5 w-3.5" />
            {!compact && <span>修改</span>}
          </button>
          // ds-allow:end
        )}
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation();
            void (async () => {
              // 图片复制位图本体；失败（协议不支持/转码失败）回退复制引用，并说清复制了什么。
              if (await copyImageToClipboard(asset)) {
                toast.success('图片已复制');
                return;
              }
              await copyPathToClipboard(getCopyReference(asset));
            })();
          }}
          title={asset.kind === 'image' ? '复制图片' : '复制引用'}
        >
          <Copy className="h-3.5 w-3.5" />
          {!compact && <span>复制</span>}
        </button>
      </span>
      {itemIds.map(
        (id) =>
          !overflowed.has(id) && (
            <span key={id} className="shrink-0">
              <button
                type="button"
                className={buttonClass}
                onClick={(event) => {
                  event.stopPropagation();
                  OVERFLOW_META[id].run();
                }}
                title={OVERFLOW_META[id].title}
              >
                {OVERFLOW_META[id].icon}
                {!compact && <span>{OVERFLOW_META[id].label}</span>}
              </button>
            </span>
          ),
      )}
      {overflowed.size > 0 && (
        <span className="relative shrink-0">
          {/* ds-allow:start 溢出 ⋯ 触发按钮沿用本条按钮组裸 button + buttonClass 风格，与相邻按钮一致；这条按钮组整体迁 primitive 时一并处理 */}
          <button
            type="button"
            className={buttonClass}
            onClick={(event) => {
              event.stopPropagation();
              setMoreOpen((v) => !v);
            }}
            title="更多"
            aria-expanded={moreOpen}
            data-testid="media-asset-overflow-more"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {/* ds-allow:end */}
          {moreOpen && (
            <span
              data-testid="media-asset-overflow-menu"
              // right-0 向左展开：收折只在宽度紧张时发生，朝紧张那一侧（右）展开必被窗口右缘裁
              // （同 DiagramToolbar 调色板浮层 2026-08-02 的修法）。
              className="absolute right-0 top-full z-20 mt-2 w-40 rounded-xl border border-border-muted bg-zinc-900/95 p-1 shadow-xl backdrop-blur"
            >
              {/* ds-allow:start 溢出菜单项为图标+文字菜单行（文字一律保留，不降级纯图标；hover 态自定义，非 Button variant），与图像动词条「更多」菜单行一致 */}
              {itemIds
                .filter((id) => overflowed.has(id))
                .map((id) => (
                  <button
                    key={id}
                    type="button"
                    data-testid={`media-asset-overflow-${id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMoreOpen(false);
                      OVERFLOW_META[id].run();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-surface-hover hover:text-zinc-100"
                  >
                    {OVERFLOW_META[id].menuIcon}
                    {OVERFLOW_META[id].label}
                  </button>
                ))}
              {/* ds-allow:end */}
            </span>
          )}
        </span>
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
