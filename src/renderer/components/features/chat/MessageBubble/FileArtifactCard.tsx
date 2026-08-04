// ============================================================================
// FileArtifactCard - Render turn-owned files and media artifacts
// ============================================================================

import React, { useMemo, useState } from 'react';
import {
  Code,
  File,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
} from 'lucide-react';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import {
  buildArtifactOwnershipMediaAsset,
  type SessionMediaAsset,
  type SessionMediaContext,
} from '@shared/utils/sessionMediaAssets';
import { useAppStore } from '../../../../stores/appStore';
import { buildTurnArtifactDeliverableCards } from '../../../../utils/deliverables';
import { DeliverableCardList } from './DeliverableCardList';
import {
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from './MediaAssetControls';

interface Props {
  items: TurnArtifactOwnershipItem[];
  mediaContext?: SessionMediaContext;
}

function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function extractToolName(ownerLabel: string): string {
  const parts = ownerLabel.split(' · ');
  return parts[parts.length - 1] || ownerLabel;
}

function pickIcon(ext: string): React.ReactNode {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  if (['md', 'mdx', 'txt'].includes(ext)) return <FileText className={`${cls} text-zinc-400`} />;
  if (['html', 'htm'].includes(ext)) return <Code className={`${cls} text-badge-warning`} />;
  if (['jsx', 'tsx', 'js', 'ts'].includes(ext)) return <Code className={`${cls} text-badge-info`} />;
  if (['csv', 'tsv'].includes(ext)) return <FileSpreadsheet className={`${cls} text-badge-success`} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <ImageIcon className={`${cls} text-badge-success`} />;
  return <File className={`${cls} text-zinc-500`} />;
}

export const FileArtifactCard: React.FC<Props> = ({ items, mediaContext }) => {
  const [expandedMedia, setExpandedMedia] = useState<SessionMediaAsset | null>(null);
  const openFilePreview = useAppStore((state) => state.openPreview);

  const { mediaEntries, deliverableCards } = useMemo(() => {
    const nextMediaEntries: Array<{
      item: TurnArtifactOwnershipItem;
      ext: string;
      status: 'created' | 'modified';
      mediaAsset: SessionMediaAsset;
    }> = [];
    const nonMediaItems: TurnArtifactOwnershipItem[] = [];

    for (const item of items) {
      const mediaAsset = buildArtifactOwnershipMediaAsset(item, mediaContext);
      if (mediaAsset) {
        const toolName = extractToolName(item.ownerLabel);
        nextMediaEntries.push({
          item,
          ext: getExt(item.label || item.path || ''),
          status: toolName === 'Write' ? 'created' : 'modified',
          mediaAsset,
        });
      } else {
        nonMediaItems.push(item);
      }
    }

    return {
      mediaEntries: nextMediaEntries,
      deliverableCards: buildTurnArtifactDeliverableCards(nonMediaItems),
    };
  }, [items, mediaContext]);

  if (mediaEntries.length === 0 && deliverableCards.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {mediaEntries.map(({ item, ext, status, mediaAsset }) => {
        const mediaSrc = getRenderableMediaSrc(mediaAsset);
        return (
          <div
            key={`${item.sourceNodeId || ''}:${mediaAsset.path || mediaAsset.url || item.label}`}
            className="overflow-hidden rounded-md border border-border-muted bg-surface-subtle transition-colors hover:border-border-muted hover:bg-surface-subtle"
            title={mediaAsset.path || mediaAsset.url || item.label}
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              {pickIcon(ext)}
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">
                {item.label}
              </span>
              <span
                className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  status === 'created'
                    ? 'bg-emerald-500/12 text-badge-success'
                    : 'bg-amber-500/12 text-badge-warning'
                }`}
              >
                {status === 'created' ? 'Created' : 'Modified'}
              </span>
            </div>

            {mediaAsset.kind === 'image' && mediaSrc && (
              /* 缩略图按内容宽度左对齐、限高一档，去掉通栏黑底 letterbox（2026-08-04 产品负责人：卡片不需要那么大）。
                 点击去右栏原生预览（与概览产物直达同一范式），file-backed 才可点；无路径的兜底回 lightbox。 */
              <button
                type="button"
                className="block w-fit cursor-zoom-in px-2.5 py-2"
                onClick={() => {
                  const filePath = item.path || mediaAsset.path;
                  if (filePath) {
                    openFilePreview(filePath);
                  } else {
                    setExpandedMedia(mediaAsset);
                  }
                }}
                title={item.path || mediaAsset.path ? '在右侧预览中查看' : '放大查看'}
              >
                <img
                  src={mediaSrc}
                  alt={item.label}
                  className="max-h-28 w-auto rounded-md"
                  loading="lazy"
                />
              </button>
            )}

            <div className="flex items-center justify-between gap-2 border-t border-border-muted bg-black/10 px-2.5 py-1.5">
              <span className="truncate text-[11px] text-zinc-500">{extractToolName(item.ownerLabel)}</span>
              <MediaAssetActionBar
                asset={mediaAsset}
                compact
                onOpenLightbox={() => setExpandedMedia(mediaAsset)}
              />
            </div>
          </div>
        );
      })}

      <DeliverableCardList cards={deliverableCards} className="" />

      {expandedMedia && (
        <MediaAssetLightbox
          asset={expandedMedia}
          onClose={() => setExpandedMedia(null)}
        />
      )}
    </div>
  );
};
