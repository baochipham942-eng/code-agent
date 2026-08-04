// ============================================================================
// OutputArtifactRows —— 概览模块四「产物」：完成态收拢的一排缩略行
// ----------------------------------------------------------------------------
// 横向一排、超出折行不滚动；图片产物给真缩略图，缩略图解析失败降级为类型图标
// + 文件名（不渲染灰底问号裂图）。标签一律人话：内部 ID 兜底「未命名输出」。
// 跑中平铺列表已随四模块归位删除（2026-08-04 拍板二/三），本文件只剩缩略行。
// ============================================================================

import { useState } from 'react';
import { File, FileText, Image as ImageIcon, Music, Video } from 'lucide-react';
import type { WorkspacePreviewItem } from '@shared/contract';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import { humanContextLabel } from '../../utils/overviewLabels';
import { resolveFileUrl } from '../../utils/resolveFileUrl';

function resolveArtifactPath(path: string, workingDirectory?: string | null): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || /^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return workingDirectory ? `${workingDirectory.replace(/\/+$/, '')}/${trimmed}` : trimmed;
}

function findPreviewItemForPath(
  previewItems: WorkspacePreviewItem[],
  path?: string,
  workingDirectory?: string | null,
): WorkspacePreviewItem | null {
  if (!path) return null;
  const normalizedPath = resolveArtifactPath(path, workingDirectory);
  return previewItems.find((item) => item.file?.path === normalizedPath) || null;
}

function findPreviewItemForArtifact(
  previewItems: WorkspacePreviewItem[],
  artifact: TurnArtifactOwnershipItem,
  workingDirectory?: string | null,
): WorkspacePreviewItem | null {
  if (artifact.path) {
    const byPath = findPreviewItemForPath(previewItems, artifact.path, workingDirectory);
    if (byPath) return byPath;
  }
  return previewItems.find((item) => item.title === artifact.label) || null;
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactThumbIcon(label: string) {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  const ext = label.includes('.') ? label.split('.').pop()?.toLowerCase() ?? '' : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return <ImageIcon className={`${cls} text-badge-success`} />;
  }
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) {
    return <Music className={`${cls} text-badge-success`} />;
  }
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
    return <Video className={`${cls} text-badge-accent`} />;
  }
  if (['md', 'mdx', 'markdown', 'txt', 'pdf', 'doc', 'docx'].includes(ext)) {
    return <FileText className={`${cls} text-zinc-400`} />;
  }
  return <File className={`${cls} text-zinc-500`} />;
}

const ArtifactThumb = ({
  item,
  previewItem,
  filePath,
  unnamedLabel,
  onOpenPreview,
  onOpenFile,
}: {
  item: TurnArtifactOwnershipItem;
  previewItem: WorkspacePreviewItem | null;
  filePath: string | null;
  unnamedLabel: string;
  onOpenPreview?: (item: WorkspacePreviewItem) => void;
  onOpenFile?: (path: string) => void;
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const name = humanContextLabel(item.label || previewItem?.title, unnamedLabel);
  const size = previewItem?.file?.size;
  const showImage = previewItem?.kind === 'image' && Boolean(filePath) && !imageFailed;

  const handleClick = () => {
    if (previewItem && onOpenPreview) {
      onOpenPreview(previewItem);
      return;
    }
    if (filePath && onOpenFile) {
      onOpenFile(filePath);
      return;
    }
  };

  const clickable = Boolean(
    (previewItem && (
      previewItem.file
      || previewItem.content?.text
      || previewItem.content?.html
      || previewItem.content?.json
      || previewItem.content?.summary
      || previewItem.content?.diff
    ))
    || (filePath && onOpenFile),
  );

  const content = (
    <>
      {showImage && filePath ? (
        <img
          src={resolveFileUrl(filePath)}
          alt={name}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-7 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        artifactThumbIcon(name)
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs text-zinc-200">{name}</span>
        {size !== undefined && (
          <span className="block text-[10px] text-zinc-600">{formatArtifactSize(size)}</span>
        )}
      </span>
    </>
  );

  if (!clickable) {
    return (
      <div
        data-testid="overview-artifact-thumb-static"
        title={name}
        className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-subtle py-1.5 pl-1.5 pr-2.5 text-left opacity-70"
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="overview-artifact-thumb"
      onClick={handleClick}
      title={filePath || name}
      className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-subtle py-1.5 pl-1.5 pr-2.5 text-left transition-colors hover:bg-surface-hover"
    >
      {content}
    </button>
  );
};

export const ArtifactThumbStrip = ({
  items,
  previewItems,
  workingDirectory,
  unnamedLabel,
  onOpenPreview,
  onOpenFile,
}: {
  items: TurnArtifactOwnershipItem[];
  previewItems: WorkspacePreviewItem[];
  workingDirectory?: string | null;
  unnamedLabel: string;
  onOpenPreview?: (item: WorkspacePreviewItem) => void;
  onOpenFile?: (path: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, 5);
  const overflow = items.length - visibleItems.length;
  return (
    <div className="flex flex-wrap gap-2">
      {visibleItems.map((item, index) => {
        const previewItem = findPreviewItemForArtifact(previewItems, item, workingDirectory);
        const filePath = previewItem?.file?.path
          || (item.path ? resolveArtifactPath(item.path, workingDirectory) : null);
        return (
          <ArtifactThumb
            key={`${item.kind}:${item.path || item.url || item.label}:${index}`}
            item={item}
            previewItem={previewItem}
            filePath={filePath}
            unnamedLabel={unnamedLabel}
            onOpenPreview={onOpenPreview}
            onOpenFile={onOpenFile}
          />
        );
      })}
      {overflow > 0 && (
        <button /* ds-allow:button: compact +N disclosure belongs in the artifact row */
          type="button"
          data-testid="overview-artifacts-more"
          onClick={() => setExpanded(true)}
          className="rounded-lg bg-surface-subtle px-2.5 py-1.5 text-[10px] text-zinc-500 hover:bg-surface-hover hover:text-zinc-300"
        >
          +{overflow}
        </button>
      )}
    </div>
  );
};
