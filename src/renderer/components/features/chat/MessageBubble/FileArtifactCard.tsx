// ============================================================================
// FileArtifactCard - 把 AI 修改/创建的文件作为独立卡片呈现
// 借鉴 CodePilot v0.52.0 的 Artifact 卡片设计
// 输入直接用 TurnArtifactOwnershipItem，复用既有数据层
// ============================================================================

import React, { useState } from 'react';
import {
  FileText, Code, Image as ImageIcon, FileSpreadsheet, Eye, File,
} from 'lucide-react';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import {
  buildArtifactOwnershipMediaAsset,
  type SessionMediaAsset,
  type SessionMediaContext,
} from '@shared/utils/sessionMediaAssets';
import { useAppStore } from '../../../../stores/appStore';
import {
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from './MediaAssetControls';

const PREVIEWABLE_EXTENSIONS = new Set([
  'md', 'mdx', 'html', 'htm', 'jsx', 'tsx', 'csv', 'tsv', 'txt',
]);

interface Props {
  items: TurnArtifactOwnershipItem[];
  mediaContext?: SessionMediaContext;
}

function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

// ownerLabel 格式："<tool>" 或 "<agent> · <tool>"，取最后一段作为工具名
function extractToolName(ownerLabel: string): string {
  const parts = ownerLabel.split(' · ');
  return parts[parts.length - 1] || ownerLabel;
}

function pickIcon(ext: string): React.ReactNode {
  const cls = 'w-3.5 h-3.5 flex-shrink-0';
  if (['md', 'mdx', 'txt'].includes(ext)) return <FileText className={`${cls} text-zinc-400`} />;
  if (['html', 'htm'].includes(ext)) return <Code className={`${cls} text-orange-400`} />;
  if (['jsx', 'tsx', 'js', 'ts'].includes(ext)) return <Code className={`${cls} text-blue-400`} />;
  if (['csv', 'tsv'].includes(ext)) return <FileSpreadsheet className={`${cls} text-green-400`} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <ImageIcon className={`${cls} text-emerald-400`} />;
  return <File className={`${cls} text-zinc-500`} />;
}

export const FileArtifactCard: React.FC<Props> = ({ items, mediaContext }) => {
  const openPreview = useAppStore((s) => s.openPreview);
  const [expandedMedia, setExpandedMedia] = useState<SessionMediaAsset | null>(null);

  if (items.length === 0) return null;

  const entries = items.map((item) => {
    const ext = getExt(item.label);
    const toolName = extractToolName(item.ownerLabel);
    const mediaAsset = buildArtifactOwnershipMediaAsset(item, mediaContext);
    return {
      item,
      ext,
      toolName,
      status: toolName === 'Write' ? ('created' as const) : ('modified' as const),
      previewable: PREVIEWABLE_EXTENSIONS.has(ext),
      mediaAsset,
    };
  });

  const mediaEntries = entries.filter((e) => e.mediaAsset);
  const previewable = entries.filter((e) => !e.mediaAsset && e.previewable);
  const others = entries.filter((e) => !e.mediaAsset && !e.previewable);

  return (
    <div className="space-y-1.5">
      {mediaEntries.map(({ item, ext, status, mediaAsset }) => {
        if (!mediaAsset) return null;
        const mediaSrc = getRenderableMediaSrc(mediaAsset);
        return (
          <div
            key={`${item.sourceNodeId || ''}:${mediaAsset.path || mediaAsset.url || item.label}`}
            className="overflow-hidden rounded-md border border-white/[0.06] bg-white/[0.018] transition-colors hover:border-white/[0.1] hover:bg-white/[0.03]"
            title={mediaAsset.path || mediaAsset.url || item.label}
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              {pickIcon(ext)}

              <span className="text-xs text-zinc-200 font-medium truncate flex-1 min-w-0">
                {item.label}
              </span>

              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
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

            <div className="flex items-center justify-between gap-2 border-t border-white/[0.05] bg-black/10 px-2.5 py-1.5">
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

      {previewable.map(({ item, ext, status }) => {
        const previewPath = item.path;
        return (
          <div
            key={`${item.sourceNodeId || ''}:${previewPath || item.label}`}
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.018] px-2.5 py-1.5 transition-colors hover:border-white/[0.1] hover:bg-white/[0.03]"
            title={previewPath || item.label}
          >
            {pickIcon(ext)}

            <span className="text-xs text-zinc-200 font-medium truncate flex-1 min-w-0">
              {item.label}
            </span>

            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                status === 'created'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-amber-500/15 text-amber-400'
              }`}
            >
              {status === 'created' ? 'Created' : 'Modified'}
            </span>

            {previewPath && (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openPreview(previewPath);
                }}
                className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                title="在预览面板打开"
              >
                <Eye className="w-3 h-3" />
                <span>Preview</span>
              </button>
            )}
          </div>
        );
      })}

      {others.length > 0 && (
        <div
          className="text-[11px] text-zinc-500 px-1 truncate"
          title={others.map((e) => e.item.path || e.item.label).join('\n')}
        >
          <span className="text-zinc-600">Also modified:</span>{' '}
          {others.map((e) => e.item.label).join(', ')}
        </div>
      )}

      {expandedMedia && (
        <MediaAssetLightbox
          asset={expandedMedia}
          onClose={() => setExpandedMedia(null)}
        />
      )}
    </div>
  );
};
