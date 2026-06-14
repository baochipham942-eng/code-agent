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
}: {
  artifactOwnership: TurnArtifactOwnershipItem[];
  previewItems: WorkspacePreviewItem[];
  workingDirectory?: string | null;
  onOpenPreview: (itemId?: string | null) => void;
}) => {
  const fallbackCards = buildTurnArtifactDeliverableCards(artifactOwnership);
  const cards: DeliverableCardView[] = artifactOwnership.flatMap((item, index) => {
    const previewItem = findPreviewItemForArtifact(previewItems, item, workingDirectory);
    if (previewItem) return [buildDeliverableCardFromWorkspaceItem(previewItem)];

    const fallbackCard = fallbackCards[index];
    return fallbackCard ? [fallbackCard] : [];
  });

  return (
    <DeliverableCardList cards={cards} className="" />
  );
};
