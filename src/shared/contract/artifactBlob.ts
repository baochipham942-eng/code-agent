// ============================================================================
// Tool Artifact / Blob Contract
// ============================================================================

import type { ArtifactRole } from './artifactRoleRegistry';

export type ToolArtifactKind =
  | 'text'
  | 'binary'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'spreadsheet'
  | 'web'
  | 'search'
  | 'process-output'
  | 'process-log';

export interface ToolArtifact {
  artifactId: string;
  kind: ToolArtifactKind;
  /** 角色轴显式覆盖：产出点确知该 artifact 的角色时标注；缺省走 kind 登记表（见 artifactRoleRegistry）。 */
  role?: ArtifactRole;
  sourceTool: string;
  createdAt: string;
  sessionId?: string;
  name?: string;
  path?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  contentLength?: number;
  preview?: string;
  metadata?: Record<string, unknown>;
}

export const TOOL_ARTIFACT_METADATA_LIMIT = 12;

export interface NormalizedToolArtifactMeta {
  artifactId?: string;
  kind: string;
  role?: ArtifactRole;
  sourceTool?: string;
  label: string;
  name?: string;
  path?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function basename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] || value;
  return withoutQuery.split('/').filter(Boolean).pop() || value;
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return basename(url);
  }
}

function normalizeRole(value: unknown): ArtifactRole | undefined {
  return value === 'deliverable' || value === 'material' || value === 'receipt' ? value : undefined;
}

function normalizeToolArtifactCandidate(value: unknown): NormalizedToolArtifactMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const kind = stringField(value, 'kind') || 'artifact';
  const role = normalizeRole(value.role);
  const sourceTool = stringField(value, 'sourceTool');
  const artifactId = stringField(value, 'artifactId');
  const path = stringField(value, 'path');
  const url = stringField(value, 'url');
  const mimeType = stringField(value, 'mimeType');
  const sizeBytes = numberField(value, 'sizeBytes');
  const sha256 = stringField(value, 'sha256');
  const preview = stringField(value, 'preview');
  const name = stringField(value, 'name')
    || stringField(value, 'title')
    || stringField(metadata, 'filename')
    || stringField(metadata, 'name')
    || stringField(metadata, 'title');

  if (!artifactId && !path && !url && !name && !stringField(value, 'kind')) {
    return undefined;
  }

  const label = name
    || (path ? basename(path) : undefined)
    || (url ? labelFromUrl(url) : undefined)
    || (sourceTool ? `${sourceTool} ${kind}` : kind);

  return {
    artifactId,
    kind,
    role,
    sourceTool,
    label,
    name,
    path,
    url,
    mimeType,
    sizeBytes,
    sha256,
    preview,
    metadata,
  };
}

function artifactDedupeKey(artifact: NormalizedToolArtifactMeta): string {
  if (artifact.path) return `path:${artifact.path}`;
  if (artifact.url) return `url:${artifact.url}`;
  if (artifact.artifactId) return `id:${artifact.artifactId}`;
  return `virtual:${artifact.kind}:${artifact.label}`;
}

export function collectToolArtifactsFromMetadata(
  metadata?: Record<string, unknown>,
  options: { limit?: number } = {},
): NormalizedToolArtifactMeta[] {
  if (!metadata) {
    return [];
  }

  const limit = Math.max(0, options.limit ?? TOOL_ARTIFACT_METADATA_LIMIT);
  if (limit === 0) {
    return [];
  }

  const candidates = [
    metadata.artifact,
    ...(Array.isArray(metadata.artifacts) ? metadata.artifacts : []),
  ];
  const artifacts: NormalizedToolArtifactMeta[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const artifact = normalizeToolArtifactCandidate(candidate);
    if (!artifact) {
      continue;
    }

    const key = artifactDedupeKey(artifact);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    artifacts.push(artifact);

    if (artifacts.length >= limit) {
      break;
    }
  }

  return artifacts;
}
