import type { NormalizedToolArtifactMeta } from '@shared/contract/artifactBlob';
import type { TurnArtifactReceiptPresentation } from '@shared/contract/turnTimeline';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function recipientSummary(
  toolMetadata: Record<string, unknown> | undefined,
  artifactMetadata: Record<string, unknown> | undefined,
): string | undefined {
  const recipients = stringArray(toolMetadata?.to).length > 0
    ? stringArray(toolMetadata?.to)
    : stringArray(artifactMetadata?.to);
  const rawCount = toolMetadata?.toCount ?? artifactMetadata?.toCount;
  const count = typeof rawCount === 'number' && Number.isFinite(rawCount)
    ? rawCount
    : recipients.length;
  const first = recipients[0];
  if (!first || count <= 0) return undefined;
  return count > 1 ? `发给 ${first} 等 ${count} 人` : `发给 ${first}`;
}

export function buildReceiptPresentation(
  artifact: NormalizedToolArtifactMeta,
  toolMetadata: Record<string, unknown> | undefined,
  success: boolean | undefined,
  fallbackToolName: string,
): TurnArtifactReceiptPresentation {
  const artifactMetadata = record(artifact.metadata);
  const recipients = recipientSummary(toolMetadata, artifactMetadata);
  return {
    status: success === false ? 'failed' : 'succeeded',
    summary: recipients ? `${artifact.label} · ${recipients}` : artifact.label,
    detail: artifact.preview,
    sourceTool: artifact.sourceTool || fallbackToolName,
  };
}
