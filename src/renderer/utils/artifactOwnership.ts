import type { TraceTurn } from '@shared/contract/trace';
import {
  collectToolArtifactsFromMetadata,
  type NormalizedToolArtifactMeta,
} from '@shared/contract/artifactBlob';
import type {
  TurnArtifactKind,
  TurnArtifactOwnershipItem,
  TurnRoutingEvidence,
} from '@shared/contract/turnTimeline';
import { buildTurnFileChanges } from './turnDiffSummary';

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

const NON_DELIVERABLE_TOOL_ARTIFACT_KINDS = new Set<NormalizedToolArtifactMeta['kind']>([
  'process-output',
  'process-log',
]);

const READ_ONLY_ARTIFACT_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'file_read',
  'glob',
  'grep',
  'listdirectory',
  'directory_list',
  'ls',
  'readclipboard',
  'clipboard_read',
  'memoryread',
  'memory_read',
  'episodicrecall',
  'episodic_recall',
]);

export function isReadOnlyArtifactTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const normalized = toolName.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return READ_ONLY_ARTIFACT_TOOL_NAMES.has(normalized);
}

export function isReadOnlyArtifactOwnershipItem(item: TurnArtifactOwnershipItem): boolean {
  if (item.ownerKind !== 'tool') return false;
  const ownerTool = item.ownerLabel.split('·').pop()?.trim();
  return isReadOnlyArtifactTool(ownerTool);
}

function shouldProjectToolArtifact(
  artifact: NormalizedToolArtifactMeta,
  fallbackToolName: string,
): boolean {
  if (NON_DELIVERABLE_TOOL_ARTIFACT_KINDS.has(artifact.kind)) {
    return false;
  }
  if (isReadOnlyArtifactTool(artifact.sourceTool || fallbackToolName)) {
    return false;
  }
  return Boolean(artifact.path || artifact.url);
}

function kindForToolArtifact(artifact: NormalizedToolArtifactMeta): TurnArtifactKind {
  if (artifact.path) {
    return 'file';
  }
  if (artifact.url) {
    return 'link';
  }
  return 'artifact';
}

function ownerLabelForToolArtifact(
  artifact: NormalizedToolArtifactMeta,
  fallbackToolName: string,
  primaryAgent?: string,
): string {
  const toolLabel = artifact.sourceTool || fallbackToolName;
  return primaryAgent ? `${primaryAgent} · ${toolLabel}` : toolLabel;
}

function dedupeKeyForToolArtifact(
  artifact: NormalizedToolArtifactMeta,
  sourceNodeId: string,
): string {
  if (artifact.path) return `file:${artifact.path}`;
  if (artifact.url) return `url:${artifact.url}`;
  if (artifact.artifactId) return `artifact:${artifact.artifactId}`;
  return `artifact:${sourceNodeId}:${artifact.kind}:${artifact.label}`;
}

export function buildArtifactOwnershipItems(
  turn: TraceTurn,
  routingEvidence?: TurnRoutingEvidence,
): TurnArtifactOwnershipItem[] {
  const items: TurnArtifactOwnershipItem[] = [];
  const seenKeys = new Set<string>();
  const primaryAgent = routingEvidence?.agentNames?.[0];
  const diffFilePaths = new Set(buildTurnFileChanges(turn).map((change) => change.filePath));

  const addItem = (item: TurnArtifactOwnershipItem, dedupeKey: string) => {
    if (seenKeys.has(dedupeKey)) {
      return;
    }
    if (item.kind === 'file' && item.path && diffFilePaths.has(item.path)) {
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
    const isReadOnlyTool = isReadOnlyArtifactTool(node.toolCall.name);

    if (!isReadOnlyTool && node.toolCall.outputPath) {
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

    if (!isReadOnlyTool) {
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

    for (const artifact of collectToolArtifactsFromMetadata(node.toolCall.metadata)) {
      if (!shouldProjectToolArtifact(artifact, node.toolCall.name)) {
        continue;
      }

      addItem({
        kind: kindForToolArtifact(artifact),
        label: artifact.label,
        ownerKind: 'tool',
        ownerLabel: ownerLabelForToolArtifact(artifact, node.toolCall.name, primaryAgent),
        path: artifact.path,
        url: artifact.url,
        sourceNodeId: node.id,
      }, dedupeKeyForToolArtifact(artifact, node.id));
    }
  }

  return items;
}
