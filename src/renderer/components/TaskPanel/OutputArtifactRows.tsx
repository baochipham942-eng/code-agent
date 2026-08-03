import { FileText } from 'lucide-react';
import type { DeliverableCardView, WorkspacePreviewItem } from '@shared/contract';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import type { ArtifactItem } from '../../hooks/useStatusRailModel';
import { DeliverableCardList } from '../features/chat/MessageBubble/DeliverableCardList';
import {
  buildDeliverableCardFromWorkspaceItem,
  buildTurnArtifactDeliverableCards,
} from '../../utils/deliverables';

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

export const OutputFileRows = ({
  files,
  previewItems,
  onOpenPreview,
  onOpenFile,
}: {
  files: ArtifactItem[];
  previewItems: WorkspacePreviewItem[];
  onOpenPreview?: (itemId?: string | null) => void;
  onOpenFile?: (path: string) => void;
}) => {
  return (
    <div className="space-y-0.5">
      {files.map((file) => (
        <OutputFileRow
          key={file.path}
          file={file}
          previewItem={findPreviewItemForPath(previewItems, file.path)}
          onOpenPreview={onOpenPreview}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
};

const OutputFileRow = ({
  file,
  previewItem,
  onOpenPreview,
  onOpenFile,
}: {
  file: ArtifactItem;
  previewItem: WorkspacePreviewItem | null;
  onOpenPreview?: (itemId?: string | null) => void;
  onOpenFile?: (path: string) => void;
}) => {
  const row = (
    <>
      <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
      <span className="text-xs text-zinc-400 truncate font-mono">{file.name}</span>
    </>
  );

  if (onOpenFile) {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(file.path)}
        className="flex w-full items-center gap-2 rounded-md py-0.5 text-left hover:bg-white/[0.035]"
        title={file.path}
        data-testid="overview-artifact-file"
      >
        {row}
      </button>
    );
  }

  if (!previewItem || !onOpenPreview) {
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
  onOpenFile,
}: {
  artifactOwnership: TurnArtifactOwnershipItem[];
  previewItems: WorkspacePreviewItem[];
  workingDirectory?: string | null;
  onOpenPreview?: (itemId?: string | null) => void;
  onOpenFile?: (path: string) => void;
}) => {
  const fallbackCards = buildTurnArtifactDeliverableCards(artifactOwnership);
  const rows = artifactOwnership.map((item, index) => {
    const previewItem = findPreviewItemForArtifact(previewItems, item, workingDirectory);
    const filePath = previewItem?.file?.path
      || (item.path ? resolveArtifactPath(item.path, workingDirectory) : null);
    const card = previewItem
      ? buildDeliverableCardFromWorkspaceItem(previewItem)
      : fallbackCards[index] || null;
    return { item, index, filePath, card };
  });

  if (onOpenFile) {
    return (
      <div className="space-y-0.5">
        {rows.map(({ item, index, filePath, card }) => {
          const rowKey = `${item.kind}:${item.path || item.url || item.label}:${index}`;
          if (filePath) {
            return (
              <button
                key={rowKey}
                type="button"
                onClick={() => onOpenFile(filePath)}
                className="flex w-full items-center gap-2 rounded-md py-0.5 text-left hover:bg-white/[0.035]"
                title={filePath}
                data-testid="overview-artifact-file"
              >
                <FileText className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
                <span className="truncate font-mono text-xs text-zinc-400">{item.label}</span>
              </button>
            );
          }
          return card ? (
            <DeliverableCardList key={rowKey} cards={[card]} className="" />
          ) : null;
        })}
      </div>
    );
  }

  const cards: DeliverableCardView[] = rows.flatMap(({ card }) => (card ? [card] : []));

  return (
    <DeliverableCardList cards={cards} className="" />
  );
};
