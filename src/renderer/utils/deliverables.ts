import type {
  Artifact,
  DeliverableCardTone,
  DeliverableCardView,
  DeliverableContextPack,
  DeliverableContract,
  DeliverableEvidencePack,
  DeliverableEvidenceRef,
  DeliverableOpenTarget,
  DeliverableQualitySummary,
  DeliverableSecondaryAction,
  DeliverableRevisionContext,
  Message,
  WorkspacePreviewItem,
  WorkspacePreviewKind,
} from '@shared/contract';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import { getFileExtension, isPreviewable } from './previewable';

function basename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] || value;
  return withoutQuery.split('/').filter(Boolean).pop() || value;
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function workspaceKindLabel(kind: WorkspacePreviewKind | string): string {
  switch (kind) {
    case 'generic_html':
      return 'HTML';
    case 'web_snapshot':
    case 'image':
      return 'Image';
    case 'spreadsheet':
      return 'Spreadsheet';
    case 'document':
      return 'Document';
    case 'audio':
      return 'Audio';
    case 'video':
      return 'Video';
    case 'archive':
      return 'Archive';
    case 'presentation':
      return 'Presentation';
    case 'chart':
      return 'Chart';
    case 'diagram':
      return 'Diagram';
    case 'question_form':
      return 'Brief';
    case 'diff':
      return 'Diff';
    case 'terminal':
      return 'Terminal';
    default:
      return String(kind || 'Artifact');
  }
}

function artifactKindLabel(type: Artifact['type']): string {
  switch (type) {
    case 'generative_ui':
      return 'HTML';
    case 'neo_ui':
      return 'Interactive UI';
    case 'question_form':
      return 'Brief';
    case 'mermaid':
      return 'Diagram';
    default:
      return workspaceKindLabel(type);
  }
}

function sourceLabelForWorkspaceItem(item: WorkspacePreviewItem): string {
  if (item.source.label) return item.source.label;
  if (item.source.toolName) return item.source.toolName;
  switch (item.source.kind) {
    case 'message':
      return 'Assistant artifact';
    case 'tool':
      return 'Tool output';
    case 'permission':
      return 'Pending change';
    case 'browser':
      return 'Browser';
    default:
      return item.source.kind;
  }
}

function toneFromEvidence(status: DeliverableEvidencePack['status']): DeliverableCardTone {
  if (status === 'failed') return 'error';
  if (status === 'verified') return 'success';
  return 'warning';
}

function toneFromQuality(quality?: DeliverableQualitySummary): DeliverableCardTone | undefined {
  if (!quality) return undefined;
  if (quality.status === 'failed') return 'error';
  if (quality.status === 'needs_review' || quality.status === 'degraded') return 'warning';
  if (quality.status === 'passed') return 'success';
  return undefined;
}

function refsStatus(refs: DeliverableEvidenceRef[]): DeliverableEvidencePack['status'] {
  if (refs.some((ref) => ref.status === 'fail')) return 'failed';
  if (refs.some((ref) => ref.status === 'pass')) return 'verified';
  return 'unverified';
}

function buildEvidencePack(refs: DeliverableEvidenceRef[]): DeliverableEvidencePack {
  const status = refsStatus(refs);
  if (status === 'failed') {
    const failed = refs.find((ref) => ref.status === 'fail');
    return {
      status,
      summary: failed?.summary || 'Verification failed',
      refs,
    };
  }
  if (status === 'verified') {
    return {
      status,
      summary: refs.filter((ref) => ref.status === 'pass').map((ref) => ref.summary)[0] || 'Basic evidence attached',
      refs,
    };
  }
  return {
    status,
    summary: 'No verification evidence yet',
    refs,
  };
}

function promptSummaryFromArgs(args: Record<string, unknown> | undefined): string {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return 'Image generation';
  return prompt.length > 72 ? `${prompt.slice(0, 72)}...` : prompt;
}

function imageConstraintsFromArgs(args: Record<string, unknown> | undefined): string[] {
  const constraints: string[] = [];
  const aspectRatio = typeof args?.aspect_ratio === 'string'
    ? args.aspect_ratio
    : typeof args?.aspectRatio === 'string'
      ? args.aspectRatio
      : undefined;
  if (aspectRatio) constraints.push(`aspect_ratio:${aspectRatio}`);
  const style = typeof args?.style === 'string' ? args.style : undefined;
  if (style) constraints.push(`style:${style}`);
  return constraints;
}

export function buildPendingImageDeliverableCards(
  message: Pick<Message, 'id' | 'timestamp' | 'toolCalls'>,
): DeliverableCardView[] {
  const pendingImageCalls = (message.toolCalls ?? []).filter((toolCall) => (
    toolCall.name === 'image_generate' && !toolCall.result
  ));
  return pendingImageCalls.map((toolCall) => {
    const promptSummary = promptSummaryFromArgs(toolCall.arguments);
    const sourceOfTruth = [`message:${message.id}`, `tool-call:${toolCall.id}`];
    const contextPack: DeliverableContextPack = {
      goal: promptSummary,
      deliverableType: 'Image',
      sourceOfTruth,
      constraints: imageConstraintsFromArgs(toolCall.arguments),
      priorArtifacts: [],
      acceptance: [
        'Generated image is persisted as a file artifact',
        'Inline base64 is omitted after persistence',
      ],
      riskNotes: ['Image generation is still running'],
    };
    const refs: DeliverableEvidenceRef[] = [
      {
        id: `${message.id}:${toolCall.id}:pending`,
        kind: 'tool_result',
        status: 'metadata',
        summary: 'Image generation in progress',
        ref: toolCall.id,
      },
    ];
    const evidencePack = buildEvidencePack(refs);

    return {
      id: `pending-image:${message.id}:${toolCall.id}`,
      kind: 'image',
      title: 'Generating image',
      description: `Image · image_generate · ${promptSummary}`,
      sourceLabel: 'image_generate',
      status: evidencePack.status,
      createdAt: message.timestamp,
      openTarget: { kind: 'none', reason: 'Image is still generating' },
      contextPack,
      contract: {
        purpose: `Generate image: ${promptSummary}`,
        expectedOutput: 'Image file artifact persisted to the workspace',
        inputRefs: sourceOfTruth,
        requiredChecks: contextPack.acceptance,
      },
      evidencePack,
      tone: 'info',
    };
  });
}

function qualityFromWorkspaceItem(item: WorkspacePreviewItem): DeliverableQualitySummary | undefined {
  if (!item.quality) return undefined;
  return {
    status: item.quality.status,
    summary: item.quality.summary,
    issueCount: item.quality.issueCount,
    blocking: item.quality.blocking,
  };
}

function revisionFromWorkspaceItem(item: WorkspacePreviewItem): DeliverableRevisionContext | undefined {
  const revision = item.revision;
  if (revision?.artifactId) {
    return {
      artifactId: revision.artifactId,
      version: revision.version,
      parentId: revision.parentId,
      parentRef: revision.parentRef,
      filePath: revision.filePath,
      sha256: revision.sha256,
      sourceTool: revision.sourceTool,
      changeSummary: revision.changeSummary,
    };
  }
  if (item.file?.path || item.file?.sha256) {
    return {
      artifactId: item.file.sha256 ? `file:${item.file.sha256.slice(0, 16)}` : `file:${item.file?.path || item.id}`,
      filePath: item.file?.path,
      sha256: item.file?.sha256,
      sourceTool: item.source.toolName || item.source.label,
    };
  }
  return undefined;
}

function secondaryActionsForWorkspaceItem(
  item: WorkspacePreviewItem,
  openTarget: DeliverableOpenTarget,
): DeliverableSecondaryAction[] {
  const actions: DeliverableSecondaryAction[] = [];
  if (item.file?.path) {
    actions.push({ kind: 'reveal-file', label: 'Reveal', path: item.file.path });
    actions.push({ kind: 'copy-reference', label: 'Copy path', value: item.file.path });
    actions.push({
      kind: 'export-bundle',
      label: 'Export bundle',
      bundleName: `${basename(item.file.name || item.title || 'deliverable')}-bundle.zip`,
      files: [{
        path: item.file.path,
        name: item.file.name || basename(item.file.path),
        role: 'primary',
        mimeType: item.file.mimeType,
        sha256: item.file.sha256,
      }],
      manifest: {
        source: 'deliverable-card',
        itemId: item.id,
        title: item.title,
        kind: item.kind,
        status: item.status,
        sourceLabel: item.source.label || item.source.toolName,
        revision: item.revision,
        quality: item.quality,
      },
    });
  } else if (openTarget.kind === 'workspace-preview') {
    actions.push({ kind: 'copy-reference', label: 'Copy ref', value: openTarget.itemId });
  }
  return actions;
}

function openTargetForWorkspaceItem(item: WorkspacePreviewItem): DeliverableOpenTarget {
  if (item.file?.path && isPreviewable(item.file.path)) {
    return { kind: 'file-preview', path: item.file.path };
  }
  if (item.content || item.kind !== 'file') {
    return { kind: 'workspace-preview', itemId: item.id };
  }
  if (item.file?.path) {
    return { kind: 'none', reason: 'File is not previewable' };
  }
  return { kind: 'workspace-preview', itemId: item.id };
}

function acceptanceForOpenTarget(openTarget: DeliverableOpenTarget): string[] {
  switch (openTarget.kind) {
    case 'file-preview':
      return ['File preview opens from the chat card'];
    case 'workspace-preview':
      return ['Workspace Preview selects the matching deliverable'];
    case 'external':
      return ['External URL opens from the deliverable card'];
    default:
      return [];
  }
}

function contextPackForWorkspaceItem(
  item: WorkspacePreviewItem,
  deliverableType: string,
  openTarget: DeliverableOpenTarget,
): DeliverableContextPack {
  const sourceOfTruth = [
    item.file?.path,
    item.source.messageId ? `message:${item.source.messageId}` : undefined,
    item.source.toolCallId ? `tool-call:${item.source.toolCallId}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    deliverableType,
    sourceOfTruth,
    constraints: [],
    priorArtifacts: item.revision?.parentRef
      ? [item.revision.parentRef]
      : item.revision?.parentId
        ? [`artifact:${item.revision.parentId}`]
        : [],
    acceptance: acceptanceForOpenTarget(openTarget),
    riskNotes: item.file?.path && !item.file.sha256
      ? ['File hash is not available yet']
      : [],
  };
}

function contractForWorkspaceItem(
  item: WorkspacePreviewItem,
  deliverableType: string,
  contextPack: DeliverableContextPack,
): DeliverableContract {
  return {
    purpose: item.subtitle || `Deliver ${deliverableType}`,
    expectedOutput: item.file?.path
      ? `${deliverableType} file at ${item.file.path}`
      : `${deliverableType} preview item`,
    inputRefs: contextPack.sourceOfTruth,
    requiredChecks: [
      ...contextPack.acceptance,
      ...(item.file?.sha256 ? ['File hash is recorded'] : []),
    ],
  };
}

function evidenceForWorkspaceItem(
  item: WorkspacePreviewItem,
  openTarget: DeliverableOpenTarget,
  quality?: DeliverableQualitySummary,
): DeliverableEvidencePack {
  const refs: DeliverableEvidenceRef[] = [
    {
      id: `${item.id}:status`,
      kind: 'workspace_status',
      status: item.status === 'failed' ? 'fail' : 'metadata',
      summary: `Workspace status: ${item.status}`,
      ref: item.id,
    },
  ];

  if (openTarget.kind === 'file-preview') {
    refs.push({
      id: `${item.id}:preview`,
      kind: 'preview_route',
      status: 'metadata',
      summary: 'Preview route is available',
      ref: openTarget.path,
    });
  } else if (openTarget.kind === 'workspace-preview') {
    refs.push({
      id: `${item.id}:workspace-preview`,
      kind: 'preview_route',
      status: 'metadata',
      summary: 'Workspace Preview route is available',
      ref: openTarget.itemId,
    });
  }

  if (item.file?.path) {
    refs.push({
      id: `${item.id}:file`,
      kind: 'file_metadata',
      status: item.file.sha256 || item.file.size !== undefined || item.file.mimeType ? 'pass' : 'metadata',
      summary: item.file.sha256
        ? `File hash ${item.file.sha256.slice(0, 12)}`
        : item.file.size !== undefined
          ? `File size ${item.file.size} bytes`
          : 'File path is recorded',
      ref: item.file.path,
    });
  }

  if (quality) {
    refs.push({
      id: `${item.id}:quality`,
      kind: quality.status === 'failed' || quality.status === 'needs_review' ? 'artifact_issue' : 'quality_report',
      status: quality.status === 'failed'
        ? 'fail'
        : quality.status === 'passed'
          ? 'pass'
          : 'metadata',
      summary: quality.summary,
      ref: item.id,
    });
  }

  return buildEvidencePack(refs);
}

export function buildDeliverableCardFromWorkspaceItem(item: WorkspacePreviewItem): DeliverableCardView {
  const deliverableType = workspaceKindLabel(item.kind);
  const sourceLabel = sourceLabelForWorkspaceItem(item);
  const openTarget = openTargetForWorkspaceItem(item);
  const contextPack = contextPackForWorkspaceItem(item, deliverableType, openTarget);
  const contract = contractForWorkspaceItem(item, deliverableType, contextPack);
  const quality = qualityFromWorkspaceItem(item);
  const evidencePack = evidenceForWorkspaceItem(item, openTarget, quality);
  const revisionContext = revisionFromWorkspaceItem(item);
  const descriptionParts = [
    item.subtitle,
    sourceLabel,
    revisionContext?.version ? `v${revisionContext.version}` : undefined,
    evidencePack.summary,
  ].filter((value): value is string => Boolean(value));

  return {
    id: `workspace:${item.id}`,
    kind: item.kind,
    title: item.title,
    description: descriptionParts.join(' · ') || `${deliverableType} deliverable`,
    sourceLabel,
    status: evidencePack.status,
    createdAt: item.createdAt,
    openTarget,
    contextPack,
    contract,
    evidencePack,
    revisionContext,
    quality,
    secondaryActions: secondaryActionsForWorkspaceItem(item, openTarget),
    tone: toneFromQuality(quality) || toneFromEvidence(evidencePack.status),
  };
}

function artifactOpenTarget(messageId: string, artifactId: string): DeliverableOpenTarget {
  return { kind: 'workspace-preview', itemId: `artifact:${messageId}:${artifactId}` };
}

function contextPackForMessageArtifact(
  message: Pick<Message, 'id'>,
  artifact: Artifact,
  deliverableType: string,
  openTarget: DeliverableOpenTarget,
): DeliverableContextPack {
  return {
    deliverableType,
    sourceOfTruth: [`message:${message.id}`],
    constraints: [],
    priorArtifacts: artifact.parentId ? [`artifact:${artifact.parentId}`] : [],
    acceptance: acceptanceForOpenTarget(openTarget),
    riskNotes: [],
  };
}

function evidenceForMessageArtifact(messageId: string, artifact: Artifact, openTarget: DeliverableOpenTarget): DeliverableEvidencePack {
  return buildEvidencePack([
    {
      id: `${messageId}:${artifact.id}:version`,
      kind: 'artifact_version',
      status: 'metadata',
      summary: `Version ${artifact.version}`,
      ref: artifact.id,
    },
    {
      id: `${messageId}:${artifact.id}:preview`,
      kind: 'preview_route',
      status: 'metadata',
      summary: openTarget.kind === 'workspace-preview'
        ? 'Workspace Preview route is available'
        : 'No preview route',
      ref: openTarget.kind === 'workspace-preview' ? openTarget.itemId : undefined,
    },
  ]);
}

export function buildMessageArtifactDeliverableCards(
  message: Pick<Message, 'id' | 'timestamp' | 'artifacts'>,
): DeliverableCardView[] {
  if (!message.artifacts?.length) return [];

  return message.artifacts.map((artifact) => {
    const deliverableType = artifactKindLabel(artifact.type);
    const title = normalizeLabel(artifact.title, deliverableType);
    const openTarget = artifactOpenTarget(message.id, artifact.id);
    const contextPack = contextPackForMessageArtifact(message, artifact, deliverableType, openTarget);
    const evidencePack = evidenceForMessageArtifact(message.id, artifact, openTarget);
    const revisionContext: DeliverableRevisionContext = {
      artifactId: artifact.id,
      version: artifact.version,
      parentId: artifact.parentId,
      parentRef: artifact.parentId ? `artifact:${artifact.parentId}` : undefined,
      changeSummary: artifact.parentId ? `Updated from ${artifact.parentId}` : undefined,
    };

    return {
      id: `message:${message.id}:${artifact.id}`,
      kind: artifact.type,
      title,
      description: `${deliverableType} · Assistant artifact · v${artifact.version}`,
      sourceLabel: 'Assistant artifact',
      status: evidencePack.status,
      createdAt: message.timestamp,
      openTarget,
      contextPack,
      contract: {
        purpose: `Deliver ${title}`,
        expectedOutput: `${deliverableType} content in Workspace Preview`,
        inputRefs: contextPack.sourceOfTruth,
        requiredChecks: contextPack.acceptance,
      },
      evidencePack,
      revisionContext,
      tone: toneFromEvidence(evidencePack.status),
    };
  });
}

function toolStatusLabel(ownerLabel: string): string {
  const toolName = ownerLabel.split(' · ').pop() || ownerLabel;
  if (/^write$/i.test(toolName)) return 'Created';
  if (/edit|append|patch|update/i.test(toolName)) return 'Modified';
  return 'Ready';
}

function openTargetForTurnArtifact(item: TurnArtifactOwnershipItem): DeliverableOpenTarget {
  if (item.path && isPreviewable(item.path)) return { kind: 'file-preview', path: item.path };
  if (item.url) return { kind: 'external', url: item.url };
  if (item.path) return { kind: 'none', reason: 'File is not previewable' };
  return { kind: 'none', reason: 'No preview target is available' };
}

function secondaryActionsForTurnArtifact(item: TurnArtifactOwnershipItem): DeliverableSecondaryAction[] {
  const actions: DeliverableSecondaryAction[] = [];
  if (item.path) {
    actions.push({ kind: 'reveal-file', label: 'Reveal', path: item.path });
    actions.push({ kind: 'copy-reference', label: 'Copy path', value: item.path });
    actions.push({
      kind: 'export-bundle',
      label: 'Export bundle',
      bundleName: `${basename(item.label || item.path)}-bundle.zip`,
      files: [{
        path: item.path,
        name: basename(item.path),
        role: 'primary',
      }],
      manifest: {
        source: 'turn-artifact',
        label: item.label,
        ownerKind: item.ownerKind,
        ownerLabel: item.ownerLabel,
        sourceNodeId: item.sourceNodeId,
      },
    });
  } else if (item.url) {
    actions.push({ kind: 'copy-reference', label: 'Copy URL', value: item.url });
  }
  return actions;
}

function kindForTurnArtifact(item: TurnArtifactOwnershipItem): string {
  if (item.path) {
    const ext = getFileExtension(item.path);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
    if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
    if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'archive';
    if (['ppt', 'pptx'].includes(ext)) return 'presentation';
    if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return 'spreadsheet';
    if (['html', 'htm'].includes(ext)) return 'generic_html';
    if (['md', 'mdx', 'markdown', 'txt', 'pdf', 'doc', 'docx'].includes(ext)) return 'document';
  }
  return item.kind;
}

export function buildTurnArtifactDeliverableCards(
  items: TurnArtifactOwnershipItem[],
): DeliverableCardView[] {
  return items.map((item, index) => {
    const openTarget = openTargetForTurnArtifact(item);
    const deliverableType = workspaceKindLabel(kindForTurnArtifact(item));
    const sourceOfTruth = [
      item.path,
      item.url,
      item.sourceNodeId ? `trace-node:${item.sourceNodeId}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const contextPack: DeliverableContextPack = {
      deliverableType,
      sourceOfTruth,
      constraints: [],
      priorArtifacts: [],
      acceptance: acceptanceForOpenTarget(openTarget),
      riskNotes: item.path && !isPreviewable(item.path) ? ['File type does not have an inline preview'] : [],
    };
    const refs: DeliverableEvidenceRef[] = [
      {
        id: `turn:${item.sourceNodeId || index}:source`,
        kind: 'tool_result',
        status: 'metadata',
        summary: toolStatusLabel(item.ownerLabel),
        ref: item.sourceNodeId,
      },
    ];
    if (openTarget.kind === 'file-preview') {
      refs.push({
        id: `turn:${item.sourceNodeId || index}:preview`,
        kind: 'preview_route',
        status: 'metadata',
        summary: 'Preview route is available',
        ref: openTarget.path,
      });
    }
    const evidencePack = buildEvidencePack(refs);

    return {
      id: `turn:${item.sourceNodeId || index}:${item.path || item.url || item.label}`,
      kind: kindForTurnArtifact(item),
      title: item.label || (item.path ? basename(item.path) : 'Artifact'),
      description: `${deliverableType} · ${item.ownerLabel} · ${toolStatusLabel(item.ownerLabel)}`,
      sourceLabel: item.ownerLabel,
      status: evidencePack.status,
      openTarget,
      contextPack,
      contract: {
        purpose: `Deliver ${item.label}`,
        expectedOutput: item.path || item.url || item.label,
        inputRefs: contextPack.sourceOfTruth,
        requiredChecks: contextPack.acceptance,
      },
      evidencePack,
      secondaryActions: secondaryActionsForTurnArtifact(item),
      tone: toneFromEvidence(evidencePack.status),
    };
  });
}
