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
  if (['html', 'htm'].includes(ext)) return <Code className={`${cls} text-orange-400`} />;
  if (['jsx', 'tsx', 'js', 'ts'].includes(ext)) return <Code className={`${cls} text-blue-400`} />;
  if (['csv', 'tsv'].includes(ext)) return <FileSpreadsheet className={`${cls} text-green-400`} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <ImageIcon className={`${cls} text-emerald-400`} />;
  return <File className={`${cls} text-zinc-500`} />;
}

export const FileArtifactCard: React.FC<Props> = ({ items, mediaContext }) => {
  const [expandedMedia, setExpandedMedia] = useState<SessionMediaAsset | null>(null);

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
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                {item.label}
              </span>
              <span
                className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  status === 'created'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-amber-500/15 text-amber-400'
                }`}
              >
                {status === 'created' ? 'Created' : 'Modified'}
              </span>
            </div>

            {mediaAsset.kind === 'image' && mediaSrc && (
              <button
                type="button"
                className="block w-full cursor-zoom-in bg-black/20"
                onClick={() => setExpandedMedia(mediaAsset)}
                title="放大查看"
              >
                <img
                  src={mediaSrc}
                  alt={item.label}
                  className="max-h-44 w-full object-contain"
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
