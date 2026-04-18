import type { TraceTurn } from '@shared/contract/trace';
import type {
  TurnArtifactOwnershipItem,
  TurnRoutingEvidence,
} from '@shared/contract/turnTimeline';

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function collectMetadataPaths(metadata?: Record<string, unknown>): string[] {
  if (!metadata) {
    return [];
  }

  const paths: string[] = [];
  for (const key of ['filePath', 'imagePath', 'videoPath', 'outputPath']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      paths.push(value.trim());
    }
  }
  return paths;
}

export function buildArtifactOwnershipItems(
  turn: TraceTurn,
  routingEvidence?: TurnRoutingEvidence,
): TurnArtifactOwnershipItem[] {
  const items: TurnArtifactOwnershipItem[] = [];
  const seenKeys = new Set<string>();
  const primaryAgent = routingEvidence?.agentNames?.[0];

  const addItem = (item: TurnArtifactOwnershipItem, dedupeKey: string) => {
    if (seenKeys.has(dedupeKey)) {
      return;
    }
    seenKeys.add(dedupeKey);
    items.push(item);
  };

  for (const node of turn.nodes) {
    if (node.type === 'assistant_text') {
      for (const artifact of node.artifacts || []) {
        addItem({
          kind: 'artifact',
          label: artifact.title || artifact.type,
          ownerKind: 'assistant',
          ownerLabel: primaryAgent || 'Assistant',
          sourceNodeId: node.id,
        }, `artifact:${node.id}:${artifact.id}`);
      }
    }

    if (node.type !== 'tool_call' || !node.toolCall) {
      continue;
    }

    const toolOwnerLabel = primaryAgent
      ? `${primaryAgent} · ${node.toolCall.name}`
      : node.toolCall.name;

    if (node.toolCall.outputPath) {
      const outputPath = node.toolCall.outputPath;
      addItem({
        kind: 'file',
        label: basename(outputPath),
        ownerKind: 'tool',
        ownerLabel: toolOwnerLabel,
        path: outputPath,
        sourceNodeId: node.id,
      }, `file:${outputPath}`);
    }

    for (const path of collectMetadataPaths(node.toolCall.metadata)) {
      addItem({
        kind: 'file',
        label: basename(path),
        ownerKind: 'tool',
        ownerLabel: toolOwnerLabel,
        path,
        sourceNodeId: node.id,
      }, `file:${path}`);
    }
  }

  return items;
}
