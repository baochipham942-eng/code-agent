// ============================================================================
// AttachmentPreview - Display attachments in messages
// ============================================================================

import React, { useState, useMemo, useEffect } from 'react';
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
  Loader2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import type { AttachmentDisplayProps, AttachmentIconConfig } from './types';
import type {
  ArchiveManifest,
  AttachmentCategory,
  MessageAttachment,
  PresentationSummary,
} from '@shared/contract';
import type { ChannelAttachment, RetryChannelMediaAttachmentResult } from '@shared/contract/channel';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { formatFileSize, FOLDER_SUMMARY_THRESHOLD, categoryLabels } from './utils';
import { resolveFileUrl } from '../../../../utils/resolveFileUrl';
import { SpreadsheetBlock } from './SpreadsheetBlock';
import { DocumentBlock } from './DocumentBlock';

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

type AttachmentStateTone = 'muted' | 'active' | 'success' | 'danger';

export function getAttachmentMediaState(attachment: MessageAttachment): {
  label: string;
  tone: AttachmentStateTone;
  spinning?: boolean;
} | null {
  const metadata = attachment.metadata || {};
  const state = attachment.mediaState
    || (typeof metadata.transcriptionState === 'string' ? metadata.transcriptionState : undefined)
    || (typeof metadata.materializationState === 'string' ? metadata.materializationState : undefined);

  switch (state) {
    case 'pending':
      return { label: '等待中', tone: 'muted' };
    case 'downloading':
      return { label: '下载中', tone: 'active', spinning: true };
    case 'embedded':
      return { label: '已嵌入', tone: 'success' };
    case 'transcribing':
      return { label: '转写中', tone: 'active', spinning: true };
    case 'ready':
      return { label: '已就绪', tone: 'success' };
    case 'failed':
      return { label: '处理失败', tone: 'danger' };
    default:
      return null;
  }
}

const AttachmentStateBadge: React.FC<{ attachment: MessageAttachment }> = ({ attachment }) => {
  return <AttachmentStateBadgeInner attachment={attachment} />;
};

const AttachmentStateBadgeInner: React.FC<{
  attachment: MessageAttachment;
  onRetry?: () => void;
  retrying?: boolean;
}> = ({ attachment, onRetry, retrying }) => {
  const state = getAttachmentMediaState(attachment);
  if (!state) return null;

  const toneClass =
    state.tone === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : state.tone === 'danger'
        ? 'border-red-500/30 bg-red-500/10 text-red-300'
        : state.tone === 'active'
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
          : 'border-zinc-600 bg-zinc-800 text-zinc-400';
  const Icon = retrying ? Loader2 : state.tone === 'danger' ? AlertCircle : state.tone === 'success' ? CheckCircle : Loader2;

  return (
    <span className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[10px] ${toneClass}`}>
      <Icon className={`h-3 w-3 ${retrying || state.spinning ? 'animate-spin' : ''}`} />
      {retrying ? '重试中' : state.label}
      {state.tone === 'danger' && onRetry && (
        <button
          type="button"
          className="ml-1 inline-flex items-center gap-0.5 rounded px-1 text-[10px] text-red-200 hover:bg-red-500/15"
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          disabled={retrying}
        >
          <RotateCcw className="h-2.5 w-2.5" />
          重试
        </button>
      )}
    </span>
  );
};

function readStringMetadata(attachment: MessageAttachment, key: string): string | undefined {
  const metadata = attachment.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getRetryAccountId(attachment: MessageAttachment): string | undefined {
  return readStringMetadata(attachment, 'accountId');
}

function toRetryChannelAttachment(attachment: MessageAttachment): ChannelAttachment {
  const resourceType = readStringMetadata(attachment, 'resourceType');
  const platformFileKey = readStringMetadata(attachment, 'platformFileKey') ?? attachment.id;
  const channelType = attachment.type === 'image'
    ? 'image'
    : resourceType === 'audio' || attachment.category === 'audio'
      ? 'audio'
      : resourceType === 'media' || attachment.category === 'video'
        ? 'video'
        : 'file';

  return {
    id: attachment.id,
    type: channelType,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    data: attachment.data,
    localPath: attachment.path,
    platformFileKey,
    mediaState: attachment.mediaState,
    metadata: attachment.metadata,
  };
}

function mergeRetriedAttachment(
  current: MessageAttachment,
  retryAttachment: ChannelAttachment | undefined,
): MessageAttachment {
  if (!retryAttachment) return current;
  return {
    ...current,
    name: retryAttachment.name || current.name,
    mimeType: retryAttachment.mimeType ?? current.mimeType,
    size: retryAttachment.size ?? current.size,
    path: retryAttachment.localPath ?? current.path,
    mediaState: retryAttachment.mediaState ?? current.mediaState,
    metadata: {
      ...(current.metadata ?? {}),
      ...(retryAttachment.metadata ?? {}),
    },
  };
}

// Single attachment item
const AttachmentItem: React.FC<{
  attachment: MessageAttachment;
  onImageClick: (src: string) => void;
}> = ({ attachment, onImageClick }) => {
  const [displayAttachment, setDisplayAttachment] = useState(attachment);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => setDisplayAttachment(attachment), [attachment]);

  const handleRetry = async () => {
    const accountId = getRetryAccountId(displayAttachment);
    if (!accountId || retrying) return;
    setRetrying(true);
    setDisplayAttachment((current) => ({ ...current, mediaState: 'downloading' }));
    try {
      const result = await ipcService.invoke(
        IPC_CHANNELS.CHANNEL_RETRY_MEDIA_ATTACHMENT,
        {
          accountId,
          attachment: toRetryChannelAttachment(displayAttachment),
        },
      ) as RetryChannelMediaAttachmentResult;
      setDisplayAttachment((current) => mergeRetriedAttachment(
        {
          ...current,
          mediaState: result.success ? 'ready' : 'failed',
          metadata: {
            ...(current.metadata ?? {}),
            ...(result.error ? { retryError: result.error } : {}),
          },
        },
        result.attachment,
      ));
    } catch (error) {
      setDisplayAttachment((current) => ({
        ...current,
        mediaState: 'failed',
        metadata: {
          ...(current.metadata ?? {}),
          retryError: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setRetrying(false);
    }
  };

  const retryAccountId = getRetryAccountId(displayAttachment);
  const showRetry = getAttachmentMediaState(displayAttachment)?.tone === 'danger' && Boolean(retryAccountId);
  const stateBadge = (
    <AttachmentStateBadgeInner
      attachment={displayAttachment}
      retrying={retrying}
      onRetry={showRetry ? handleRetry : undefined}
    />
  );
  const attachmentView = displayAttachment;
  const category = attachmentView.category || (attachmentView.type === 'image' ? 'image' : 'other');
  const presentationSummary = useMemo(
    () => parseJson<PresentationSummary>(attachmentView.pptJson),
    [attachmentView.pptJson],
  );
  const archiveManifest = attachmentView.archiveManifest as ArchiveManifest | undefined;

  if (category === 'image') {
    // 优先使用 data/thumbnail，否则回退到本地文件路径
    const imageSrc = attachmentView.thumbnail || attachmentView.data || (attachmentView.path ? resolveFileUrl(attachmentView.path) : '');
    return (
      <div
        className="relative group cursor-pointer"
        onClick={() => onImageClick(imageSrc)}
      >
        <img
          src={imageSrc}
          alt={attachmentView.name}
          className="max-w-[200px] max-h-[150px] rounded-xl border border-zinc-700 shadow-lg object-cover hover:border-primary-500/50 transition-colors"
        />
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center">
          <ImageIcon className="w-6 h-6 text-white" />
        </div>
        <div className="absolute bottom-1 left-1">
          {stateBadge}
        </div>
      </div>
    );
  }

  if (category === 'audio') {
    const mediaSrc = attachmentView.data || (attachmentView.path ? resolveFileUrl(attachmentView.path) : '');
    return (
      <div className="max-w-[260px] rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <div className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
          <Music className="h-4 w-4 text-fuchsia-400" />
          <span className="truncate" title={attachmentView.name}>{attachmentView.name}</span>
          {stateBadge}
        </div>
        <audio controls src={mediaSrc} className="w-full" />
      </div>
    );
  }

  if (category === 'video') {
    const mediaSrc = attachmentView.data || (attachmentView.path ? resolveFileUrl(attachmentView.path) : '');
    return (
      <div className="max-w-[320px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/80">
        <video
          controls
          src={mediaSrc}
          className="max-h-[220px] w-full bg-black object-contain"
        />
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-300">
          <Video className="h-4 w-4 shrink-0 text-cyan-400" />
          <span className="truncate" title={attachmentView.name}>{attachmentView.name}</span>
          {stateBadge}
        </div>
      </div>
    );
  }

  // Excel with JSON data → interactive SpreadsheetBlock
  if (category === 'excel' && attachmentView.sheetsJson) {
    return <SpreadsheetBlock spec={attachmentView.sheetsJson} />;
  }

  // Word (.docx) with JSON data → interactive DocumentBlock
  if (category === 'document' && attachmentView.docxJson) {
    return <DocumentBlock spec={attachmentView.docxJson} />;
  }

  if (category === 'presentation') {
    const slideCount = presentationSummary?.slideCount;
    const firstSlides = presentationSummary?.slides?.slice(0, 2) || [];
    return (
      <div className="flex max-w-[260px] items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <Presentation className="mt-0.5 h-5 w-5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-zinc-200" title={attachmentView.name}>
            {attachmentView.name}
          </div>
          <div className="text-xs text-zinc-500">
            {slideCount !== undefined ? `${slideCount} 页` : formatFileSize(attachmentView.size)}
          </div>
          {stateBadge}
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
          <div className="truncate text-sm text-zinc-200" title={attachmentView.name}>
            {attachmentView.name}
          </div>
          <div className="text-xs text-zinc-500">
            {archiveManifest
              ? `${archiveManifest.format} · ${archiveManifest.totalFiles} 文件`
              : formatFileSize(attachmentView.size)}
          </div>
          {stateBadge}
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
  const displayName = attachmentView.name.includes('/')
    ? attachmentView.name.split('/').pop() || attachmentView.name
    : attachmentView.name;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-700/60 border border-zinc-700 max-w-[200px]">
      <span className={color}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200 truncate" title={attachmentView.name}>
          {displayName}
        </div>
        <div className="text-xs text-zinc-500 flex items-center gap-1">
          <span className={`${color} text-2xs`}>{label}</span>
          <span>·</span>
          {category === 'pdf' && attachmentView.pageCount
            ? <span>{attachmentView.pageCount} 页</span>
            : category === 'excel' && attachmentView.sheetCount
              ? <span>{attachmentView.sheetCount} 表 · {attachmentView.rowCount} 行</span>
              : attachmentView.language
                ? <span>{attachmentView.language}</span>
                : <span>{formatFileSize(attachmentView.size)}</span>
          }
        </div>
        {stateBadge}
      </div>
    </div>
  );
};

// Main attachment display component
export const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({ attachments }) => {
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
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
            onImageClick={setExpandedImage}
          />
        ))}
      </div>

      {/* Image lightbox */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Expanded"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};
