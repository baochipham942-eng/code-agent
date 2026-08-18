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
import { DiffView } from '../../../DiffView';
import type { FileChange } from '../../../../utils/turnDiffSummary';
import {
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from './MediaAssetControls';

interface Props {
  items: TurnArtifactOwnershipItem[];
  mediaContext?: SessionMediaContext;
  fileChangesByPath?: ReadonlyMap<string, FileChange>;
}

const DeliverableDiffDetail: React.FC<{ change: FileChange }> = ({ change }) => {
  const [expanded, setExpanded] = useState(false);
  const hasLineChanges = change.added > 0 || change.removed > 0;

  return (
    <div className="border-t border-border-muted px-2.5 py-1.5">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
      >
        {expanded ? <span aria-hidden="true">⌄</span> : <span aria-hidden="true">›</span>}
        <span>本次变更</span>
        {hasLineChanges && (
          <span className="flex items-center gap-1">
            {change.added > 0 && <span className="text-badge-success">+{change.added} 行</span>}
            {change.removed > 0 && <span className="text-badge-danger">-{change.removed} 行</span>}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5">
          <DiffView
            oldText={change.oldText}
            newText={change.newText}
            fileName={change.filePath.split('/').pop() || change.filePath}
            stats={{ added: change.added, removed: change.removed }}
            className="overflow-hidden rounded-md border border-border-muted"
          />
        </div>
      )}
    </div>
  );
};

function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
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

export const FileArtifactCard: React.FC<Props> = ({ items, mediaContext, fileChangesByPath }) => {
  const [expandedMedia, setExpandedMedia] = useState<SessionMediaAsset | null>(null);
  const openFilePreview = useAppStore((state) => state.openPreview);

  const { mediaEntries, deliverableCards } = useMemo(() => {
    const nextMediaEntries: Array<{
      item: TurnArtifactOwnershipItem;
      ext: string;
      mediaAsset: SessionMediaAsset;
    }> = [];
    const nonMediaItems: TurnArtifactOwnershipItem[] = [];

    for (const item of items) {
      const mediaAsset = buildArtifactOwnershipMediaAsset(item, mediaContext);
      if (mediaAsset) {
        nextMediaEntries.push({
          item,
          ext: getExt(item.label || item.path || ''),
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
      {mediaEntries.map(({ item, ext, mediaAsset }) => {
        const mediaSrc = getRenderableMediaSrc(mediaAsset);
        return (
          <div
            key={`${item.sourceNodeId || ''}:${mediaAsset.path || mediaAsset.url || item.label}`}
            /* 卡片跟着缩略图收宽（2026-08-04 产品负责人：别通栏），min-w 兜住头部文件名+尾部动作条。
               overflow-visible：动作条的 ⋯ 溢出菜单朝卡片外弹，overflow-hidden 会把菜单整个裁掉
               （2026-08-05 真机：「三个点点了没反应」）；圆角由尾行自己的 rounded-b 补。 */
            className="w-fit min-w-64 max-w-full overflow-visible rounded-md border border-border-muted bg-surface-subtle transition-colors hover:border-border-muted hover:bg-surface-subtle"
            title={mediaAsset.path || mediaAsset.url || item.label}
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              {pickIcon(ext)}
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">
                {item.label}
              </span>
              {/* 2026-08-05 产品负责人：媒体产物卡不摆文件状态角标——生成图被标 Modified 是错的，
                  且英文黑话对用户零信息量；文件编辑状态由「已编辑文件」卡（TurnDiffSummary）负责。 */}
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

            {/* 2026-08-05 产品负责人：尾行不摆内部工具名（image_generate 等），只留动作按钮；
                rounded-b 补回容器 overflow-visible 后损失的底角裁切 */}
            <div className="flex items-center justify-end gap-2 rounded-b-[5px] border-t border-border-muted bg-black/10 px-2.5 py-1.5">
              <MediaAssetActionBar
                asset={mediaAsset}
                compact
                onOpenLightbox={() => setExpandedMedia(mediaAsset)}
              />
            </div>
            {(() => {
              const change = item.path ? fileChangesByPath?.get(item.path) : undefined;
              return change ? <DeliverableDiffDetail change={change} /> : null;
            })()}
          </div>
        );
      })}

      <DeliverableCardList
        cards={deliverableCards}
        className=""
        renderCardDetail={(card) => {
          const path = card.openTarget.kind === 'file-preview' ? card.openTarget.path : undefined;
          const change = path ? fileChangesByPath?.get(path) : undefined;
          return change ? <DeliverableDiffDetail change={change} /> : null;
        }}
      />

      {expandedMedia && (
        <MediaAssetLightbox
          asset={expandedMedia}
          onClose={() => setExpandedMedia(null)}
        />
      )}
    </div>
  );
};
