// ============================================================================
// ToolDetails - Expandable details area showing arguments and results
// ============================================================================

import React, { useState } from 'react';
import {
  ExternalLink,
  Folder,
  Image as ImageIcon,
  FileText,
  Play,
  Video,
  Download,
} from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { DiffView } from '../../../../DiffView';
import { useAppStore } from '../../../../../stores/appStore';

interface Props {
  toolCall: ToolCall;
  compact?: boolean;
}

export function ToolDetails({ toolCall, compact }: Props) {
  const { name, arguments: args, result } = toolCall;
  const [showDiff, setShowDiff] = useState(true);
  const openPreview = useAppStore((state) => state.openPreview);

  // Check if this is edit_file tool
  const isEditFile = name === 'edit_file';
  const editFileArgs = isEditFile
    ? {
        filePath: (args?.file_path as string) || '',
        oldString: (args?.old_string as string) || '',
        newString: (args?.new_string as string) || '',
      }
    : null;

  // Check for special file results
  const createdFilePath = extractCreatedFilePath(toolCall);
  const imageResult = extractImageResult(toolCall);
  const videoResult = extractVideoResult(toolCall);
  const generatedFileResult = extractGeneratedFile(toolCall);

  const isHtmlFile =
    createdFilePath?.toLowerCase().endsWith('.html') ||
    createdFilePath?.toLowerCase().endsWith('.htm');

  return (
    <div className="ml-8 mt-2 space-y-2 text-xs">
      {/* Diff view for edit_file */}
      {isEditFile && editFileArgs && showDiff && (
        <div className="animate-fadeIn">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
            <span>Diff</span>
            <div className="flex-1 h-px bg-gray-700/50" />
            <button
              onClick={() => setShowDiff(false)}
              className="text-gray-500 hover:text-gray-300 px-2 transition-colors"
            >
              Hide
            </button>
          </div>
          <DiffView
            oldText={editFileArgs.oldString}
            newText={editFileArgs.newString}
            fileName={editFileArgs.filePath.split('/').pop()}
            className="border border-gray-700/50 rounded-lg overflow-hidden"
          />
        </div>
      )}

      {/* Arguments section - hidden in compact mode */}
      {!compact && args && (
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
            <span>Arguments</span>
            <div className="flex-1 h-px bg-gray-700/50" />
            {isEditFile && !showDiff && (
              <button
                onClick={() => setShowDiff(true)}
                className="text-blue-400 hover:text-blue-300 px-2 transition-colors"
              >
                View Diff
              </button>
            )}
          </div>
          <pre className="text-xs text-gray-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto border border-gray-800/50 whitespace-pre-wrap">
            {isEditFile && editFileArgs
              ? `File: ${editFileArgs.filePath}\nChanges: ${editFileArgs.oldString.length} -> ${editFileArgs.newString.length} chars`
              : formatArgs(name, args)}
          </pre>
        </div>
      )}

      {/* Result section */}
      {result && (
        <div className="animate-fadeIn">
          {!imageResult && !videoResult && !generatedFileResult && !createdFilePath && (
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
              <span>{result.success ? 'Result' : 'Error'}</span>
              <div className="flex-1 h-px bg-gray-700/50" />
            </div>
          )}

          {/* Image result display */}
          {imageResult && result.success && (
            <ImageResultDisplay
              imagePath={imageResult.imagePath}
              imageBase64={imageResult.imageBase64}
            />
          )}

          {/* Video result display */}
          {videoResult && result.success && (
            <VideoResultDisplay
              videoUrl={videoResult.videoUrl}
              coverUrl={videoResult.coverUrl}
              videoPath={videoResult.videoPath}
              duration={videoResult.duration}
              aspectRatio={videoResult.aspectRatio}
            />
          )}

          {/* Generated file display (ppt_generate, etc.) */}
          {generatedFileResult && result.success && (
            <FileResultDisplay
              filePath={generatedFileResult.filePath}
              isHtml={false}
              onPreview={() => {}}
            />
          )}

          {/* Created file display for write_file */}
          {createdFilePath && result.success && (
            <FileResultDisplay
              filePath={createdFilePath}
              isHtml={isHtmlFile || false}
              onPreview={() => openPreview(createdFilePath)}
            />
          )}

          {/* Standard result output */}
          {!imageResult && !videoResult && !generatedFileResult && !createdFilePath && (
            <pre
              className={`text-xs bg-gray-900/50 rounded-lg p-3 overflow-x-auto max-h-48 border transition-colors duration-200 ${
                result.success
                  ? 'text-gray-400 border-gray-800/50'
                  : 'text-red-300 border-red-500/20'
              }`}
            >
              {result.error
                ? result.error
                : typeof result.output === 'string'
                  ? result.output
                  : JSON.stringify(result.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatArgs(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case 'read_file': {
      let filePath = (args.file_path as string) || '';
      if (filePath.includes(' offset=') || filePath.includes(' limit=')) {
        filePath = filePath.split(' ')[0];
      }
      const offset = args.offset as number;
      const limit = args.limit as number;
      let result = `File: ${filePath}`;
      if (offset && offset > 1) result += `\nOffset: ${offset}`;
      if (limit && limit !== 2000) result += `\nLimit: ${limit}`;
      return result;
    }

    case 'write_file': {
      const filePath = (args.file_path as string) || '';
      const content = (args.content as string) || '';
      return `File: ${filePath}\nContent: ${content.length} chars`;
    }

    case 'bash': {
      const command = (args.command as string) || '';
      return `Command:\n${command}`;
    }

    case 'glob': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return `Pattern: ${pattern}\nPath: ${path}`;
    }

    case 'grep': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return `Pattern: ${pattern}\nPath: ${path}`;
    }

    case 'list_directory': {
      const path = (args.path as string) || '.';
      return `Path: ${path}`;
    }

    default:
      return JSON.stringify(args, null, 2);
  }
}

function extractCreatedFilePath(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
  result?: { success: boolean; output?: unknown };
}): string | null {
  if (toolCall.name !== 'write_file') return null;

  // If result exists and failed, don't show file
  if (toolCall.result && !toolCall.result.success) return null;

  // Try to extract from result output first (has absolute path)
  const output = toolCall.result?.output as string;
  if (output) {
    // Match path up to " (" which precedes the byte count, or end of line
    // Output format: "Created file: /path/to/file (1234 bytes)"
    const match = output.match(/(?:Created|Updated) file: (.+?)(?:\s+\(|\n|$)/);
    if (match) return match[1].trim();
  }

  // Fallback to arguments.file_path (may be relative path)
  // Note: This path may be relative and won't work for shell.openPath()
  // but still useful for display purposes
  return (toolCall.arguments?.file_path as string) || null;
}

function extractImageResult(toolCall: {
  name: string;
  result?: { success: boolean; metadata?: Record<string, unknown> };
}): { imagePath?: string; imageBase64?: string } | null {
  if (toolCall.name !== 'image_generate' || !toolCall.result?.success)
    return null;
  const metadata = toolCall.result.metadata;
  if (!metadata) return null;

  const imagePath = metadata.imagePath as string | undefined;
  const imageBase64 = metadata.imageBase64 as string | undefined;

  if (imagePath || imageBase64) {
    return { imagePath, imageBase64 };
  }
  return null;
}

function extractGeneratedFile(toolCall: {
  name: string;
  result?: { success: boolean; metadata?: Record<string, unknown> };
}): { filePath: string; fileName: string } | null {
  if (!['ppt_generate'].includes(toolCall.name) || !toolCall.result?.success)
    return null;
  const metadata = toolCall.result.metadata;
  if (!metadata) return null;

  const filePath = metadata.filePath as string | undefined;
  const fileName = metadata.fileName as string | undefined;

  if (filePath && fileName) {
    return { filePath, fileName };
  }
  return null;
}

function extractVideoResult(toolCall: {
  name: string;
  result?: { success: boolean; metadata?: Record<string, unknown> };
}): {
  videoUrl?: string;
  coverUrl?: string;
  videoPath?: string;
  duration?: number;
  aspectRatio?: string;
} | null {
  if (toolCall.name !== 'video_generate' || !toolCall.result?.success)
    return null;
  const metadata = toolCall.result.metadata;
  if (!metadata) return null;

  const videoUrl = metadata.videoUrl as string | undefined;
  const coverUrl = metadata.coverUrl as string | undefined;
  const videoPath = metadata.videoPath as string | undefined;
  const duration = metadata.duration as number | undefined;
  const aspectRatio = metadata.aspectRatio as string | undefined;

  if (videoUrl || videoPath) {
    return { videoUrl, coverUrl, videoPath, duration, aspectRatio };
  }
  return null;
}

// ============================================================================
// File Display Components
// ============================================================================

interface ImageResultDisplayProps {
  imagePath?: string;
  imageBase64?: string;
}

function ImageResultDisplay({ imagePath, imageBase64 }: ImageResultDisplayProps) {
  const [imageError, setImageError] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const imageSrc = imagePath
    ? `file://${imagePath}`
    : imageBase64
      ? imageBase64.startsWith('data:')
        ? imageBase64
        : `data:image/png;base64,${imageBase64}`
      : '';

  const fileName = imagePath?.split('/').pop() || 'generated-image.png';

  const handleOpenFile = async () => {
    if (imagePath) {
      try {
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
        await window.domainAPI?.invoke('workspace', 'showItemInFolder', {
          filePath: imagePath,
        });
      } catch (error) {
        console.error('Failed to show in folder:', error);
      }
    }
  };

  if (imageError || !imageSrc) {
    if (imagePath) {
      return (
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
            <button
              onClick={handleOpenFile}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 text-xs"
            >
              <ExternalLink className="w-3 h-3" />
              Open
            </button>
          </div>
        </div>
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
        {imagePath && (
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
    </div>
  );
}

interface FileResultDisplayProps {
  filePath: string;
  isHtml: boolean;
  onPreview: () => void;
}

function FileResultDisplay({
  filePath,
  isHtml,
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
      await window.domainAPI?.invoke('workspace', 'openPath', { filePath });
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const handleShowInFolder = async () => {
    try {
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
        {isHtml && (
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
}

function VideoResultDisplay({
  videoUrl,
  coverUrl,
  videoPath,
  duration,
  aspectRatio,
}: VideoResultDisplayProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [showCover, setShowCover] = useState(true);

  const handleOpenFile = async () => {
    if (videoPath) {
      try {
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
        await window.domainAPI?.invoke('workspace', 'showItemInFolder', {
          filePath: videoPath,
        });
      } catch (error) {
        console.error('Failed to show in folder:', error);
      }
    }
  };

  const handleDownload = () => {
    if (videoUrl) {
      window.open(videoUrl, '_blank');
    }
  };

  const handlePlayInline = () => {
    setShowCover(false);
    setIsPlaying(true);
  };

  const fileName = videoPath?.split('/').pop() || 'video.mp4';
  const infoText = [duration ? `${duration}s` : null, aspectRatio]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 overflow-hidden">
      {/* Video preview area */}
      <div className="relative aspect-video bg-gray-900/50">
        {showCover && coverUrl ? (
          <>
            <img
              src={coverUrl}
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
        ) : videoUrl ? (
          <video
            src={videoUrl}
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
          {videoUrl && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 text-xs"
              title="在浏览器中打开"
            >
              <Download className="w-3 h-3" />
              下载
            </button>
          )}
          {videoPath && (
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
    </div>
  );
}
