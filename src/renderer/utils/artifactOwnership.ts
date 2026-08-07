import type { TraceTurn } from '@shared/contract/trace';
import {
  collectToolArtifactsFromMetadata,
  type NormalizedToolArtifactMeta,
} from '@shared/contract/artifactBlob';
import { resolveArtifactRole } from '@shared/contract/artifactRoleRegistry';
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
          // 模型显式创建的 artifact 本身就是交付物
          role: 'deliverable',
          sourceNodeId: node.id,
        }, `artifact:${node.id}:${artifact.id}`);
      }
    }

    if (node.type !== 'tool_call' || !node.toolCall) {
      continue;
    }

    // 产物条目生成门槛（2026-08-04 C.12）：参数校验失败 / 执行失败的调用不建条目——
    // trace 实证幻觉工具 "Blob" 的失败调用生成了带 "Blob" 标签的裂图卡。
    if (node.toolCall.success === false) {
      continue;
    }

    const toolOwnerLabel = primaryAgent
      ? `${primaryAgent} · ${node.toolCall.name}`
      : node.toolCall.name;
    const toolArtifacts = collectToolArtifactsFromMetadata(node.toolCall.metadata);

    // metadata 路径兜底通道：只对完全没产出 ToolArtifact 的调用生效——产了 artifact 的
    // 一律以角色轴为准，不再扫 outputPath / metadata 路径，否则 imageAnalyze 的 imagePath
    // （来源图）这类读取路径会绕过角色判据混进产物。
    // 清单（isReadOnlyArtifactTool）只在这条兜底通道上继续承重。
    if (toolArtifacts.length === 0 && !isReadOnlyArtifactTool(node.toolCall.name)) {
      if (node.toolCall.outputPath) {
        const outputPath = node.toolCall.outputPath;
        addItem({
          kind: 'file',
          label: basename(outputPath),
          ownerKind: 'tool',
          ownerLabel: toolOwnerLabel,
          role: 'deliverable',
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
          role: 'deliverable',
          path,
          sourceNodeId: node.id,
        }, `file:${path}`);
      }
    }

    for (const artifact of toolArtifacts) {
      if (!artifact.path && !artifact.url) {
        continue;
      }

      addItem({
        kind: kindForToolArtifact(artifact),
        label: artifact.label,
        ownerKind: 'tool',
        ownerLabel: ownerLabelForToolArtifact(artifact, node.toolCall.name, primaryAgent),
        // 角色轴单一判据：deliverable 进产物区，material 进「来源」区（见 artifactRoleRegistry）
        role: resolveArtifactRole(artifact),
        path: artifact.path,
        url: artifact.url,
        sourceNodeId: node.id,
      }, dedupeKeyForToolArtifact(artifact, node.id));
    }
  }

  return items;
}
