// ============================================================================
// ToolResultMediaDisplays - 工具结果的媒体展示叶子组件（图片/视频/通用媒体/文件）
// 从 ToolDetails.tsx 抽出，保持 ToolDetails 体量可控（max-lines 1000）。
// 纯展示组件：靠 props 渲染，不直接读 store。
// ============================================================================

import React, { useState } from 'react';
import { ExternalLink, Folder, Image as ImageIcon, FileText, Play, Video } from 'lucide-react';
import type { AgentPointerEvent } from '@shared/contract';
import type { SessionMediaAsset } from '@shared/utils/sessionMediaAssets';
import { isWebMode, copyPathToClipboard } from '../../../../../utils/platform';
import { resolveFileUrl } from '../../../../../utils/resolveFileUrl';
import { AgentPointerOverlay } from '../../../../workbench/AgentPointerOverlay';
import {
  getMediaAssetFileName,
  getMediaAssetSourceSummary,
  getRenderableMediaSrc,
  MediaAssetActionBar,
  MediaAssetLightbox,
} from '../MediaAssetControls';

interface ImageResultDisplayProps {
  imagePath?: string;
  imageBase64?: string;
  asset?: SessionMediaAsset;
  pointerEvent?: AgentPointerEvent | null;
}

export function ImageResultDisplay({ imagePath, imageBase64, asset, pointerEvent }: ImageResultDisplayProps) {
  const [imageError, setImageError] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lightboxAsset, setLightboxAsset] = useState<SessionMediaAsset | null>(null);

  const imageSrc = asset
    ? getRenderableMediaSrc(asset)
    : imagePath
    ? resolveFileUrl(imagePath)
    : imageBase64
      ? imageBase64.startsWith('data:')
        ? imageBase64
        : imageBase64.startsWith('http://') || imageBase64.startsWith('https://')
          ? imageBase64 // URL 直接用（兼容旧数据 + 下载失败降级）
          : `data:image/png;base64,${imageBase64}`
      : '';

  const fileName = asset ? getMediaAssetFileName(asset) : imagePath?.split('/').pop() || 'generated-image.png';

  const handleOpenFile = async () => {
    if (imagePath) {
      try {
        if (isWebMode()) { await copyPathToClipboard(imagePath); return; }
        await window.domainAPI?.invoke('workspace', 'openPath', {
          filePath: imagePath,
        });
      } catch (error) {
        console.error('Failed to open image:', error);
      }
    }
  };

  const handleShowInFolder = async () => {
    if (imagePath) {
      try {
        if (isWebMode()) { await copyPathToClipboard(imagePath); return; }
        await window.domainAPI?.invoke('workspace', 'showItemInFolder', {
          filePath: imagePath,
        });
      } catch (error) {
        console.error('Failed to show in folder:', error);
      }
    }
  };

  if (imageError || !imageSrc) {
    if (imagePath || asset) {
      return (
        <>
          <div className="flex items-center gap-3 p-3 rounded-lg border bg-purple-500/10 border-purple-500/30">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400">
              <ImageIcon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate text-purple-400">
                {fileName}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {asset ? (
                <MediaAssetActionBar
                  asset={asset}
                  compact
                  onOpenLightbox={() => setLightboxAsset(asset)}
                />
              ) : (
                <button
                  onClick={handleOpenFile}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open
                </button>
              )}
            </div>
          </div>
          {lightboxAsset && (
            <MediaAssetLightbox
              asset={lightboxAsset}
              onClose={() => setLightboxAsset(null)}
            />
          )}
        </>
      );
    }
    return null;
  }

  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 overflow-hidden">
      <div
        className={`relative cursor-pointer transition-all duration-300 ${isExpanded ? '' : 'max-h-64'}`}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <img
          src={imageSrc}
          alt="Generated"
          className={`w-full object-contain ${isExpanded ? '' : 'max-h-64'}`}
          onError={() => setImageError(true)}
        />
        {pointerEvent && <AgentPointerOverlay event={pointerEvent} compact={!isExpanded} />}
        {!isExpanded && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-gray-900/80 to-transparent flex items-end justify-center pb-1">
            <span className="text-xs text-gray-400">Click to expand</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 p-2 bg-gray-900/50 border-t border-purple-500/20">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-purple-400 truncate">{fileName}</div>
        </div>
        {asset ? (
          <MediaAssetActionBar
            asset={asset}
            compact
            onOpenLightbox={() => setLightboxAsset(asset)}
          />
        ) : imagePath && (
          <>
            <button
              onClick={handleOpenFile}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
            >
              <ExternalLink className="w-3 h-3" />
              Open
            </button>
            <button
              onClick={handleShowInFolder}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
            >
              <Folder className="w-3 h-3" />
              Finder
            </button>
          </>
        )}
      </div>
      {lightboxAsset && (
        <MediaAssetLightbox
          asset={lightboxAsset}
          onClose={() => setLightboxAsset(null)}
        />
      )}
    </div>
  );
}

export function GenericMediaResultDisplay({
  asset,
  pointerEvent,
}: {
  asset: SessionMediaAsset;
  pointerEvent?: AgentPointerEvent | null;
}) {
  const [lightboxAsset, setLightboxAsset] = useState<SessionMediaAsset | null>(null);
  const mediaSrc = getRenderableMediaSrc(asset);
  const fileName = getMediaAssetFileName(asset);
  const sourceText = getMediaAssetSourceSummary(asset);
  const placeholderText = asset.state === 'failed'
    ? '媒体生成失败'
    : asset.state === 'pending'
      ? '媒体生成中'
      : '媒体预览不可用';

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/60">
      {asset.kind === 'image' && mediaSrc && (
        <button
          type="button"
          className="relative block w-full cursor-zoom-in bg-black/20"
          onClick={() => setLightboxAsset(asset)}
          title="放大查看"
        >
          <img
            src={mediaSrc}
            alt={fileName}
            className="max-h-64 w-full object-contain"
            loading="lazy"
          />
          {pointerEvent && <AgentPointerOverlay event={pointerEvent} compact />}
        </button>
      )}
      {asset.kind === 'video' && mediaSrc && (
        <video
          src={mediaSrc}
          controls
          className="max-h-64 w-full bg-black object-contain"
        />
      )}
      {asset.kind === 'audio' && mediaSrc && (
        <div className="p-3">
          <audio src={mediaSrc} controls className="w-full" />
        </div>
      )}
      {!mediaSrc && (
        <div className="flex min-h-[92px] items-center justify-center bg-black/20 px-3 py-4 text-center text-xs text-zinc-500">
          {placeholderText}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/50 p-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-zinc-200">{fileName}</div>
          <div className="truncate text-[11px] text-zinc-500">{sourceText}</div>
          {asset.error && (
            <div className="mt-0.5 truncate text-[11px] text-red-300" title={asset.error}>
              {asset.error}
            </div>
          )}
        </div>
        <MediaAssetActionBar
          asset={asset}
          compact
          onOpenLightbox={() => setLightboxAsset(asset)}
        />
      </div>
      {lightboxAsset && (
        <MediaAssetLightbox
          asset={lightboxAsset}
          onClose={() => setLightboxAsset(null)}
        />
      )}
    </div>
  );
}

interface FileResultDisplayProps {
  filePath: string;
  canPreview: boolean;
  onPreview: () => void;
}

export function FileResultDisplay({
  filePath,
  canPreview,
  onPreview,
}: FileResultDisplayProps) {
  const fileName = filePath.split('/').pop() || filePath;
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  const getFileColor = () => {
    switch (ext) {
      case 'pptx':
      case 'ppt':
        return 'text-orange-400 bg-orange-500/10 border-orange-500/30';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
        return 'text-purple-400 bg-purple-500/10 border-purple-500/30';
      case 'html':
      case 'htm':
        return 'text-blue-400 bg-blue-500/10 border-blue-500/30';
      default:
        return 'text-gray-400 bg-gray-500/10 border-gray-500/30';
    }
  };

  const handleOpenFile = async () => {
    try {
      if (isWebMode()) { await copyPathToClipboard(filePath); return; }
      await window.domainAPI?.invoke('workspace', 'openPath', { filePath });
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const handleShowInFolder = async () => {
    try {
      if (isWebMode()) { await copyPathToClipboard(filePath); return; }
      await window.domainAPI?.invoke('workspace', 'showItemInFolder', {
        filePath,
      });
    } catch (error) {
      console.error('Failed to show in folder:', error);
    }
  };

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg border ${getFileColor()}`}
    >
      <div className="p-2 rounded-lg bg-current/10">
        <FileText className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{fileName}</div>
        <div className="text-xs text-gray-500 truncate">{filePath}</div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {canPreview && (
          <button
            onClick={onPreview}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs"
          >
            <Play className="w-3 h-3" />
            Preview
          </button>
        )}
        <button
          onClick={handleOpenFile}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
        >
          <ExternalLink className="w-3 h-3" />
          Open
        </button>
        <button
          onClick={handleShowInFolder}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
        >
          <Folder className="w-3 h-3" />
          Finder
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Video Result Display Component
// ============================================================================

interface VideoResultDisplayProps {
  videoUrl?: string;
  coverUrl?: string;
  videoPath?: string;
  duration?: number;
  aspectRatio?: string;
  asset?: SessionMediaAsset;
}

export function VideoResultDisplay({
  videoUrl,
  coverUrl,
  videoPath,
  duration,
  aspectRatio,
  asset,
}: VideoResultDisplayProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [showCover, setShowCover] = useState(true);
  const [lightboxAsset, setLightboxAsset] = useState<SessionMediaAsset | null>(null);

  const handleOpenFile = async () => {
    if (videoPath) {
      try {
        if (isWebMode()) { await copyPathToClipboard(videoPath); return; }
        await window.domainAPI?.invoke('workspace', 'openPath', {
          filePath: videoPath,
        });
      } catch (error) {
        console.error('Failed to open video:', error);
      }
    }
  };

  const handleShowInFolder = async () => {
    if (videoPath) {
      try {
        if (isWebMode()) { await copyPathToClipboard(videoPath); return; }
        await window.domainAPI?.invoke('workspace', 'showItemInFolder', {
          filePath: videoPath,
        });
      } catch (error) {
        console.error('Failed to show in folder:', error);
      }
    }
  };

  const handlePlayInline = () => {
    setShowCover(false);
    setIsPlaying(true);
  };

  const fileName = asset ? getMediaAssetFileName(asset) : videoPath?.split('/').pop() || 'video.mp4';
  const videoSrc = asset ? getRenderableMediaSrc(asset) : videoUrl;
  const coverSrc = asset?.thumbnailUrl || coverUrl;
  const infoText = [duration ? `${duration}s` : null, aspectRatio]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 overflow-hidden">
      {/* Video preview area */}
      <div className="relative aspect-video bg-gray-900/50">
        {showCover && coverSrc ? (
          <>
            <img
              src={coverSrc}
              alt="Video cover"
              className="w-full h-full object-cover"
            />
            <button
              onClick={handlePlayInline}
              className="absolute inset-0 flex items-center justify-center bg-black/40 hover:bg-black/30 transition-colors"
            >
              <div className="w-16 h-16 rounded-full bg-cyan-500/90 flex items-center justify-center">
                <Play className="w-8 h-8 text-white ml-1" />
              </div>
            </button>
          </>
        ) : videoSrc ? (
          <video
            src={videoSrc}
            controls
            autoPlay={isPlaying}
            className="w-full h-full"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Video className="w-12 h-12 text-cyan-500/50" />
          </div>
        )}
      </div>

      {/* Info bar */}
      <div className="flex items-center gap-2 p-2 bg-gray-900/50 border-t border-cyan-500/20">
        <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400">
          <Video className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-cyan-400 truncate font-medium">
            {fileName}
          </div>
          {infoText && (
            <div className="text-xs text-gray-500">{infoText}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {asset ? (
            <MediaAssetActionBar
              asset={asset}
              compact
              onOpenLightbox={() => setLightboxAsset(asset)}
            />
          ) : videoPath && (
            <>
              <button
                onClick={handleOpenFile}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
                title="用默认播放器打开"
              >
                <ExternalLink className="w-3 h-3" />
                打开
              </button>
              <button
                onClick={handleShowInFolder}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
                title="在 Finder 中显示"
              >
                <Folder className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      </div>
      {lightboxAsset && (
        <MediaAssetLightbox
          asset={lightboxAsset}
          onClose={() => setLightboxAsset(null)}
        />
      )}
    </div>
  );
}
