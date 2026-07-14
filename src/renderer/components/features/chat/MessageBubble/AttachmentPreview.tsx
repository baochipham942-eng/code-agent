// ============================================================================
// AttachmentPreview - Display attachments in messages
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode,
  FileText,
  FolderSearch,
  Globe,
  Image as ImageIcon,
  Loader2,
  Music,
  Presentation,
  RotateCcw,
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
import type { ChannelAttachment, RetryChannelMediaAttachmentResult } from '@shared/contract/channel';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  buildAttachmentMediaAsset,
  type SessionMediaAsset,
  type SessionMediaContext,
} from '@shared/utils/sessionMediaAssets';
import ipcService from '../../../../services/ipcService';
import { formatFileSize, FOLDER_SUMMARY_THRESHOLD, categoryLabels } from './utils';
import { resolveFileUrl } from '../../../../utils/resolveFileUrl';
import { SpreadsheetBlock } from './SpreadsheetBlock';
import { DocumentBlock } from './DocumentBlock';
import {
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from './MediaAssetControls';

function getAttachmentIconConfig(category: AttachmentCategory | undefined): AttachmentIconConfig {
  const iconClass = 'w-5 h-5 shrink-0';
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

const AttachmentStateBadge: React.FC<{
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

const AttachmentItem: React.FC<{
  attachment: MessageAttachment;
  mediaContext?: SessionMediaContext;
  onMediaOpen: (asset: SessionMediaAsset) => void;
}> = ({ attachment, mediaContext, onMediaOpen }) => {
  const [displayAttachment, setDisplayAttachment] = useState(attachment);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => setDisplayAttachment(attachment), [attachment]);

  const category = displayAttachment.category || (displayAttachment.type === 'image' ? 'image' : 'other');
  // 定点反馈要的是能交给 DocEdit 的本地绝对路径。渠道附件的 path 可能是 http(s) URL
  // （channelAgentBridge.pathFromAttachmentUrl 会把 URL 原样当 path），传给下游会让模型
  // 去编辑一个不存在的文件 —— 只放行绝对路径。
  const localFilePath = displayAttachment.path?.startsWith('/') ? displayAttachment.path : undefined;
  const presentationSummary = useMemo(
    () => parseJson<PresentationSummary>(displayAttachment.pptJson),
    [displayAttachment.pptJson],
  );
  const archiveManifest = displayAttachment.archiveManifest as ArchiveManifest | undefined;
  const mediaAsset = useMemo(
    () => buildAttachmentMediaAsset(displayAttachment, mediaContext),
    [displayAttachment, mediaContext],
  );

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
    <AttachmentStateBadge
      attachment={displayAttachment}
      retrying={retrying}
      onRetry={showRetry ? handleRetry : undefined}
    />
  );

  if (category === 'image') {
    const imageSrc = mediaAsset
      ? getRenderableMediaSrc(mediaAsset)
      : displayAttachment.thumbnail || displayAttachment.data || (displayAttachment.path ? resolveFileUrl(displayAttachment.path) : '');
    return (
      <div className="group max-w-[220px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/80 shadow-lg">
        {imageSrc ? (
          <div
            className="relative cursor-pointer"
            onClick={() => mediaAsset && onMediaOpen(mediaAsset)}
          >
            <img
              src={imageSrc}
              alt={displayAttachment.name}
              className="max-h-[150px] w-full object-cover transition-colors group-hover:border-primary-500/50"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
              <ImageIcon className="w-6 h-6 text-white" />
            </div>
            <div className="absolute bottom-1 left-1">{stateBadge}</div>
          </div>
        ) : (
          <div className="flex min-h-[84px] items-center justify-center px-3 py-4 text-center text-xs text-zinc-500">
            图片过大，已跳过内联预览
          </div>
        )}
        {(mediaAsset || stateBadge) && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 bg-zinc-950/60 px-2 py-1">
            <div>{stateBadge}</div>
            {mediaAsset && (
              <MediaAssetActionBar
                asset={mediaAsset}
                compact
                onOpenLightbox={() => onMediaOpen(mediaAsset)}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (category === 'audio') {
    const mediaSrc = mediaAsset
      ? getRenderableMediaSrc(mediaAsset)
      : displayAttachment.data || (displayAttachment.path ? resolveFileUrl(displayAttachment.path) : '');
    return (
      <div className="max-w-[260px] rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <div className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
          <Music className="h-4 w-4 text-fuchsia-400" />
          <span className="truncate" title={displayAttachment.name}>{displayAttachment.name}</span>
          {stateBadge}
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
      : displayAttachment.data || (displayAttachment.path ? resolveFileUrl(displayAttachment.path) : '');
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
          <span className="truncate" title={displayAttachment.name}>{displayAttachment.name}</span>
          {stateBadge}
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

  if (category === 'excel' && displayAttachment.sheetsJson) {
    return <SpreadsheetBlock spec={displayAttachment.sheetsJson} filePath={localFilePath} />;
  }

  if (category === 'document' && displayAttachment.docxJson) {
    return <DocumentBlock spec={displayAttachment.docxJson} />;
  }

  if (category === 'presentation') {
    const slideCount = presentationSummary?.slideCount;
    const firstSlides = presentationSummary?.slides?.slice(0, 2) || [];
    return (
      <div className="flex max-w-[260px] items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
        <Presentation className="mt-0.5 h-5 w-5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-zinc-200" title={displayAttachment.name}>
            {displayAttachment.name}
          </div>
          <div className="text-xs text-zinc-500">
            {slideCount !== undefined ? `${slideCount} 页` : formatFileSize(displayAttachment.size)}
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
          <div className="truncate text-sm text-zinc-200" title={displayAttachment.name}>
            {displayAttachment.name}
          </div>
          <div className="text-xs text-zinc-500">
            {archiveManifest
              ? `${archiveManifest.format} · ${archiveManifest.totalFiles} 文件`
              : formatFileSize(displayAttachment.size)}
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
  const displayName = displayAttachment.name.includes('/')
    ? displayAttachment.name.split('/').pop() || displayAttachment.name
    : displayAttachment.name;

  return (
    <div className="flex max-w-[200px] items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-700/60 px-3 py-2">
      <span className={color}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-200" title={displayAttachment.name}>
          {displayName}
        </div>
        <div className="flex items-center gap-1 text-xs text-zinc-500">
          <span className={`${color} text-2xs`}>{label}</span>
          <span>·</span>
          {category === 'pdf' && displayAttachment.pageCount
            ? <span>{displayAttachment.pageCount} 页</span>
            : category === 'excel' && displayAttachment.sheetCount
              ? <span>{displayAttachment.sheetCount} 表 · {displayAttachment.rowCount} 行</span>
              : displayAttachment.language
                ? <span>{displayAttachment.language}</span>
                : <span>{formatFileSize(displayAttachment.size)}</span>
          }
        </div>
        {stateBadge}
      </div>
    </div>
  );
};

export const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({ attachments, mediaContext }) => {
  const [expandedMedia, setExpandedMedia] = useState<SessionMediaAsset | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const stats = useMemo(() => {
    const byCategory: Record<string, number> = {};
    let totalSize = 0;

    for (const att of attachments) {
      const cat = att.category || (att.type === 'image' ? 'image' : 'other');
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      totalSize += att.size;
    }

    const firstSlash = attachments[0]?.name.indexOf('/');
    const folderName = firstSlash > 0 ? attachments[0].name.substring(0, firstSlash) : null;
    const isFromFolder = folderName && attachments.every((a) => a.name.startsWith(`${folderName}/`));

    return { byCategory, totalSize, folderName: isFromFolder ? folderName : null };
  }, [attachments]);

  const showSummary = attachments.length > FOLDER_SUMMARY_THRESHOLD;

  if (showSummary && !isExpanded) {
    const summaryParts = Object.entries(stats.byCategory)
      .map(([cat, count]) => `${count} ${categoryLabels[cat] || cat}`)
      .join(', ');

    return (
      <div className="mb-2 flex justify-end">
        <div
          className="flex cursor-pointer items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-700/60 px-4 py-3 transition-colors hover:bg-zinc-700"
          onClick={() => setIsExpanded(true)}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary-500/20 to-accent-purple/20">
            <FolderSearch className="h-5 w-5 text-primary-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-zinc-200">
              {stats.folderName ? `📁 ${stats.folderName}` : `📎 ${attachments.length} 个文件`}
            </div>
            <div className="text-xs text-zinc-500">
              {summaryParts} · {formatFileSize(stats.totalSize)}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2">
      {showSummary && isExpanded && (
        <div className="mb-2 flex justify-end">
          <button
            onClick={() => setIsExpanded(false)}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-400"
          >
            <ChevronDown className="h-3 w-3" />
            收起 {attachments.length} 个文件
          </button>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {attachments.map((attachment) => (
          <AttachmentItem
            key={attachment.id}
            attachment={attachment}
            mediaContext={mediaContext}
            onMediaOpen={setExpandedMedia}
          />
        ))}
      </div>

      {expandedMedia && (
        <MediaAssetLightbox
          asset={expandedMedia}
          onClose={() => setExpandedMedia(null)}
        />
      )}
    </div>
  );
};
