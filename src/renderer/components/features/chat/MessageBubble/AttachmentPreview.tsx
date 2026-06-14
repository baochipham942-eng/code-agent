// ============================================================================
// AttachmentPreview - Display attachments in messages
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderSearch,
  Image as ImageIcon,
  File,
  FileText,
  FileCode,
  Database,
  Globe,
  Archive,
  Music,
  Presentation,
  Sheet,
  Video,
} from 'lucide-react';
import type { AttachmentDisplayProps, AttachmentIconConfig } from './types';
import type {
  ArchiveManifest,
  AttachmentCategory,
  MessageAttachment,
  PresentationSummary,
} from '@shared/contract';
import {
  buildAttachmentMediaAsset,
  type SessionMediaAsset,
  type SessionMediaContext,
} from '@shared/utils/sessionMediaAssets';
import { formatFileSize, FOLDER_SUMMARY_THRESHOLD, categoryLabels } from './utils';
import { resolveFileUrl } from '../../../../utils/resolveFileUrl';
import { SpreadsheetBlock } from './SpreadsheetBlock';
import { DocumentBlock } from './DocumentBlock';
import {
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from './MediaAssetControls';

// Get attachment icon config based on category
function getAttachmentIconConfig(category: AttachmentCategory | undefined): AttachmentIconConfig {
  const iconClass = "w-5 h-5 shrink-0";
  switch (category) {
    case 'pdf':
      return { icon: <FileText className={iconClass} />, color: 'text-red-400', label: 'PDF' };
    case 'audio':
      return { icon: <Music className={iconClass} />, color: 'text-fuchsia-400', label: '音频' };
    case 'video':
      return { icon: <Video className={iconClass} />, color: 'text-cyan-400', label: '视频' };
    case 'excel':
      return { icon: <Sheet className={iconClass} />, color: 'text-emerald-400', label: 'Excel' };
    case 'presentation':
      return { icon: <Presentation className={iconClass} />, color: 'text-violet-400', label: 'PPT' };
    case 'archive':
      return { icon: <Archive className={iconClass} />, color: 'text-yellow-400', label: '压缩包' };
    case 'code':
      return { icon: <FileCode className={iconClass} />, color: 'text-blue-400', label: '代码' };
    case 'data':
      return { icon: <Database className={iconClass} />, color: 'text-amber-400', label: '数据' };
    case 'html':
      return { icon: <Globe className={iconClass} />, color: 'text-orange-400', label: 'HTML' };
    case 'text':
      return { icon: <FileText className={iconClass} />, color: 'text-zinc-400', label: '文本' };
    default:
      return { icon: <File className={iconClass} />, color: 'text-zinc-500', label: '文件' };
  }
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

// Single attachment item
const AttachmentItem: React.FC<{
  attachment: MessageAttachment;
  mediaContext?: SessionMediaContext;
  onMediaOpen: (asset: SessionMediaAsset) => void;
}> = ({ attachment, mediaContext, onMediaOpen }) => {
  const category = attachment.category || (attachment.type === 'image' ? 'image' : 'other');
  const presentationSummary = useMemo(
    () => parseJson<PresentationSummary>(attachment.pptJson),
    [attachment.pptJson],
  );
  const archiveManifest = attachment.archiveManifest as ArchiveManifest | undefined;
  const mediaAsset = useMemo(
    () => buildAttachmentMediaAsset(attachment, mediaContext),
    [attachment, mediaContext],
  );

  if (category === 'image') {
    // 统一走 MediaAsset 的安全 src 判断，避免超大 dataUrl 直接进入 DOM。
    const imageSrc = mediaAsset
      ? getRenderableMediaSrc(mediaAsset)
      : attachment.thumbnail || attachment.data || (attachment.path ? resolveFileUrl(attachment.path) : '');
    return (
      <div className="group max-w-[220px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/80 shadow-lg">
        {imageSrc ? (
          <div
            className="relative cursor-pointer"
            onClick={() => mediaAsset && onMediaOpen(mediaAsset)}
          >
            <img
              src={imageSrc}
              alt={attachment.name}
              className="max-h-[150px] w-full object-cover transition-colors group-hover:border-primary-500/50"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
              <ImageIcon className="w-6 h-6 text-white" />
            </div>
          </div>
        ) : (
          <div className="flex min-h-[84px] items-center justify-center px-3 py-4 text-center text-xs text-zinc-500">
            图片过大，已跳过内联预览
          </div>
        )}
        {mediaAsset && (
          <div className="flex items-center justify-end border-t border-zinc-800 bg-zinc-950/60 px-2 py-1">
            <MediaAssetActionBar
              asset={mediaAsset}
              compact
              onOpenLightbox={() => onMediaOpen(mediaAsset)}
            />
          </div>
        )}
      </div>
    );
  }

  if (category === 'audio') {
    const mediaSrc = mediaAsset
      ? getRenderableMediaSrc(mediaAsset)
      : attachment.data || (attachment.path ? resolveFileUrl(attachment.path) : '');
    return (
      <div className="max-w-[260px] rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <div className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
          <Music className="h-4 w-4 text-fuchsia-400" />
          <span className="truncate" title={attachment.name}>{attachment.name}</span>
        </div>
        {mediaSrc ? (
          <audio controls src={mediaSrc} className="w-full" />
        ) : (
          <div className="rounded-md border border-zinc-700/70 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500">
            音频过大，已跳过内联预览
          </div>
        )}
        {mediaAsset && (
          <div className="mt-2 flex justify-end">
            <MediaAssetActionBar
              asset={mediaAsset}
              compact
              onOpenLightbox={() => onMediaOpen(mediaAsset)}
            />
          </div>
        )}
      </div>
    );
  }

  if (category === 'video') {
    const mediaSrc = mediaAsset
      ? getRenderableMediaSrc(mediaAsset)
      : attachment.data || (attachment.path ? resolveFileUrl(attachment.path) : '');
    return (
      <div className="max-w-[320px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/80">
        {mediaSrc ? (
          <video
            controls
            src={mediaSrc}
            className="max-h-[220px] w-full bg-black object-contain"
          />
        ) : (
          <div className="flex min-h-[120px] items-center justify-center bg-black/30 px-3 py-4 text-center text-xs text-zinc-500">
            视频过大，已跳过内联预览
          </div>
        )}
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-300">
          <Video className="h-4 w-4 shrink-0 text-cyan-400" />
          <span className="truncate" title={attachment.name}>{attachment.name}</span>
          {mediaAsset && (
            <div className="ml-auto">
              <MediaAssetActionBar
                asset={mediaAsset}
                compact
                onOpenLightbox={() => onMediaOpen(mediaAsset)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Excel with JSON data → interactive SpreadsheetBlock
  if (category === 'excel' && attachment.sheetsJson) {
    return <SpreadsheetBlock spec={attachment.sheetsJson} />;
  }

  // Word (.docx) with JSON data → interactive DocumentBlock
  if (category === 'document' && attachment.docxJson) {
    return <DocumentBlock spec={attachment.docxJson} />;
  }

  if (category === 'presentation') {
    const slideCount = presentationSummary?.slideCount;
    const firstSlides = presentationSummary?.slides?.slice(0, 2) || [];
    return (
      <div className="flex max-w-[260px] items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <Presentation className="mt-0.5 h-5 w-5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-zinc-200" title={attachment.name}>
            {attachment.name}
          </div>
          <div className="text-xs text-zinc-500">
            {slideCount !== undefined ? `${slideCount} 页` : formatFileSize(attachment.size)}
          </div>
          {firstSlides.length > 0 && (
            <div className="mt-1 space-y-0.5 text-xs text-zinc-400">
              {firstSlides.map((slide) => (
                <div key={slide.index} className="truncate" title={slide.title || slide.textPreview}>
                  第 {slide.index} 页 {slide.title || slide.textPreview || '无文字标题'}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (category === 'archive') {
    const dangerCount = archiveManifest?.dangerousEntries?.length || 0;
    return (
      <div className="flex max-w-[240px] items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <Archive className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-zinc-200" title={attachment.name}>
            {attachment.name}
          </div>
          <div className="text-xs text-zinc-500">
            {archiveManifest
              ? `${archiveManifest.format} · ${archiveManifest.totalFiles} 文件`
              : formatFileSize(attachment.size)}
          </div>
          {archiveManifest && (
            <div className={`mt-1 truncate text-xs ${dangerCount > 0 ? 'text-amber-300' : 'text-zinc-400'}`}>
              {archiveManifest.supported
                ? `${archiveManifest.entries.length}${archiveManifest.truncated ? '+' : ''} 项清单`
                : archiveManifest.note}
              {dangerCount > 0 ? ` · ${dangerCount} 个可疑路径` : ''}
            </div>
          )}
        </div>
      </div>
    );
  }

  const { icon, color, label } = getAttachmentIconConfig(category);
  // Only show file name without folder path
  const displayName = attachment.name.includes('/')
    ? attachment.name.split('/').pop() || attachment.name
    : attachment.name;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-700/60 border border-zinc-700 max-w-[200px]">
      <span className={color}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200 truncate" title={attachment.name}>
          {displayName}
        </div>
        <div className="text-xs text-zinc-500 flex items-center gap-1">
          <span className={`${color} text-2xs`}>{label}</span>
          <span>·</span>
          {category === 'pdf' && attachment.pageCount
            ? <span>{attachment.pageCount} 页</span>
            : category === 'excel' && attachment.sheetCount
              ? <span>{attachment.sheetCount} 表 · {attachment.rowCount} 行</span>
              : attachment.language
                ? <span>{attachment.language}</span>
                : <span>{formatFileSize(attachment.size)}</span>
          }
        </div>
      </div>
    </div>
  );
};

// Main attachment display component
export const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({ attachments, mediaContext }) => {
  const [expandedMedia, setExpandedMedia] = useState<SessionMediaAsset | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate stats
  const stats = useMemo(() => {
    const byCategory: Record<string, number> = {};
    let totalSize = 0;

    for (const att of attachments) {
      const cat = att.category || (att.type === 'image' ? 'image' : 'other');
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      totalSize += att.size;
    }

    // Check if from same folder
    const firstSlash = attachments[0]?.name.indexOf('/');
    const folderName = firstSlash > 0 ? attachments[0].name.substring(0, firstSlash) : null;
    const isFromFolder = folderName && attachments.every((a) => a.name.startsWith(folderName + '/'));

    return { byCategory, totalSize, folderName: isFromFolder ? folderName : null };
  }, [attachments]);

  // Show summary if file count exceeds threshold
  const showSummary = attachments.length > FOLDER_SUMMARY_THRESHOLD;

  // Summary view
  if (showSummary && !isExpanded) {
    const summaryParts = Object.entries(stats.byCategory)
      .map(([cat, count]) => `${count} ${categoryLabels[cat] || cat}`)
      .join(', ');

    return (
      <div className="mb-2 flex justify-end">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-700/60 border border-zinc-700 cursor-pointer hover:bg-zinc-700 transition-colors"
          onClick={() => setIsExpanded(true)}
        >
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary-500/20 to-accent-purple/20 flex items-center justify-center">
            <FolderSearch className="w-5 h-5 text-primary-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-zinc-200 font-medium">
              {stats.folderName ? `📁 ${stats.folderName}` : `📎 ${attachments.length} 个文件`}
            </div>
            <div className="text-xs text-zinc-500">
              {summaryParts} · {formatFileSize(stats.totalSize)}
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2">
      {/* Collapse button when expanded */}
      {showSummary && isExpanded && (
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setIsExpanded(false)}
            className="text-xs text-zinc-500 hover:text-zinc-400 flex items-center gap-1"
          >
            <ChevronDown className="w-3 h-3" />
            收起 {attachments.length} 个文件
          </button>
        </div>
      )}

      {/* File list */}
      <div className="flex flex-wrap gap-2 justify-end">
        {attachments.map((attachment) => (
          <AttachmentItem
            key={attachment.id}
            attachment={attachment}
            mediaContext={mediaContext}
            onMediaOpen={setExpandedMedia}
          />
        ))}
      </div>

      {/* Media lightbox */}
      {expandedMedia && (
        <MediaAssetLightbox
          asset={expandedMedia}
          onClose={() => setExpandedMedia(null)}
        />
      )}
    </div>
  );
};
