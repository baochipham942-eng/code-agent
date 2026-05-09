import { FileText } from 'lucide-react';
import type { WorkspacePreviewItem } from '@shared/contract';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import type { ArtifactItem } from '../../hooks/useStatusRailModel';
import { WorkbenchPill } from '../workbench/WorkbenchPrimitives';

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

function isValidatorTestOutput(item: TurnArtifactOwnershipItem): boolean {
  if (item.kind === 'artifact' || item.kind === 'link' || item.kind === 'note') return false;
  const target = `${item.path || ''} ${item.label || ''}`;
  return /metrics\.json\b|__GAME_TEST|__test__/i.test(target);
}

function getArtifactKindLabel(item: TurnArtifactOwnershipItem): string {
  if (isValidatorTestOutput(item)) return 'Test';
  switch (item.kind) {
    case 'artifact':
      return 'Artifact';
    case 'link':
      return 'Link';
    case 'note':
      return 'Note';
    default:
      return 'File';
  }
}

function getArtifactPillTone(item: TurnArtifactOwnershipItem): 'info' | 'neutral' | 'mcp' {
  if (isValidatorTestOutput(item)) return 'mcp';
  return item.kind === 'artifact' ? 'info' : 'neutral';
}

export const OutputFileRows = ({
  files,
  previewItems,
  onOpenPreview,
}: {
  files: ArtifactItem[];
  previewItems: WorkspacePreviewItem[];
  onOpenPreview: (itemId?: string | null) => void;
}) => {
  return (
    <div className="space-y-0.5">
      {files.map((file) => (
        <OutputFileRow
          key={file.path}
          file={file}
          previewItem={findPreviewItemForPath(previewItems, file.path)}
          onOpenPreview={onOpenPreview}
        />
      ))}
    </div>
  );
};

const OutputFileRow = ({
  file,
  previewItem,
  onOpenPreview,
}: {
  file: ArtifactItem;
  previewItem: WorkspacePreviewItem | null;
  onOpenPreview: (itemId?: string | null) => void;
}) => {
  const row = (
    <>
      <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
      <span className="text-xs text-zinc-400 truncate font-mono">{file.name}</span>
    </>
  );

  if (!previewItem) {
    return (
      <div className="flex items-center gap-2 py-0.5" title={file.path}>
        {row}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenPreview(previewItem.id)}
      className="flex w-full items-center gap-2 rounded-md py-0.5 text-left hover:bg-white/[0.035]"
      title={file.path}
    >
      {row}
    </button>
  );
};

export const CurrentTurnArtifactOwnershipCard = ({
  artifactOwnership,
  previewItems,
  workingDirectory,
  onOpenPreview,
}: {
  artifactOwnership: TurnArtifactOwnershipItem[];
  previewItems: WorkspacePreviewItem[];
  workingDirectory?: string | null;
  onOpenPreview: (itemId?: string | null) => void;
}) => {
  return (
    <div className="space-y-1.5">
      {artifactOwnership.map((item, index) => (
        <CurrentTurnArtifactOwnershipRow
          key={`${item.kind}-${item.label}-${index}`}
          item={item}
          previewItem={findPreviewItemForArtifact(previewItems, item, workingDirectory)}
          onOpenPreview={onOpenPreview}
        />
      ))}
    </div>
  );
};

const CurrentTurnArtifactOwnershipRow = ({
  item,
  previewItem,
  onOpenPreview,
}: {
  item: TurnArtifactOwnershipItem;
  previewItem: WorkspacePreviewItem | null;
  onOpenPreview: (itemId?: string | null) => void;
}) => {
  const row = (
    <>
      <WorkbenchPill tone={getArtifactPillTone(item)}>
        {getArtifactKindLabel(item)}
      </WorkbenchPill>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-zinc-100">{item.label}</div>
        <div className="truncate text-[11px] text-zinc-500">{item.ownerLabel}</div>
      </div>
    </>
  );

  if (!previewItem) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
        title={item.path || item.url || item.label}
      >
        {row}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenPreview(previewItem.id)}
      className="flex w-full items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-left hover:border-cyan-500/25 hover:bg-cyan-500/[0.045]"
      title={item.path || item.url || item.label}
    >
      {row}
    </button>
  );
};
