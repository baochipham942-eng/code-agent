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

function recipientPresentation(
  toolMetadata: Record<string, unknown> | undefined,
  artifactMetadata: Record<string, unknown> | undefined,
): TurnArtifactReceiptPresentation['recipient'] {
  const recipients = stringArray(toolMetadata?.to).length > 0
    ? stringArray(toolMetadata?.to)
    : stringArray(artifactMetadata?.to);
  const rawCount = toolMetadata?.toCount ?? artifactMetadata?.toCount;
  const count = typeof rawCount === 'number' && Number.isFinite(rawCount)
    ? rawCount
    : recipients.length;
  const first = recipients[0];
  if (!first || count <= 0) return undefined;
  return { first, count };
}

export function formatReceiptSummary(
  summary: string,
  recipient: TurnArtifactReceiptPresentation['recipient'],
  copy: { recipientSingle: string; recipientMultiple: string },
): string {
  if (!recipient) return summary;
  const template = recipient.count > 1 ? copy.recipientMultiple : copy.recipientSingle;
  const recipientText = template
    .replace('{first}', recipient.first)
    .replace('{count}', String(recipient.count));
  return `${summary} · ${recipientText}`;
}

export function buildReceiptPresentation(
  artifact: NormalizedToolArtifactMeta,
  toolMetadata: Record<string, unknown> | undefined,
  success: boolean | undefined,
  fallbackToolName: string,
): TurnArtifactReceiptPresentation {
  const artifactMetadata = record(artifact.metadata);
  const connectorValue = artifactMetadata?.connector ?? toolMetadata?.connector;
  const connector = typeof connectorValue === 'string' && connectorValue.trim()
    ? connectorValue.trim()
    : undefined;
  return {
    status: success === false ? 'failed' : 'succeeded',
    summary: artifact.label,
    detail: artifact.preview,
    sourceTool: artifact.sourceTool || fallbackToolName,
    connector,
    recipient: recipientPresentation(toolMetadata, artifactMetadata),
  };
}
