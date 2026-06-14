import type { Message, MessageAttachment, ToolCall } from '../contract';
import { collectToolArtifactsFromMetadata } from '../contract/artifactBlob';
import type { TurnArtifactOwnershipItem } from '../contract/turnTimeline';

export type SessionMediaKind = 'image' | 'video' | 'audio';
export type SessionMediaSource = 'attachment' | 'markdown' | 'tool_result' | 'artifact';
export type SessionMediaRole = 'input' | 'output' | 'intermediate';
export type SessionMediaState = 'pending' | 'ready' | 'failed';

export interface SessionMediaSourceRef {
  source: SessionMediaSource;
  role: SessionMediaRole;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  attachmentId?: string;
  artifactId?: string;
  label?: string;
}

export interface SessionMediaAsset {
  assetId: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  source: SessionMediaSource;
  role: SessionMediaRole;
  sources: SessionMediaSourceRef[];
  kind: SessionMediaKind;
  state: SessionMediaState;
  mimeType?: string;
  url?: string;
  path?: string;
  dataUrl?: string;
  thumbnailUrl?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  prompt?: string;
  model?: string;
  parentAssetIds?: string[];
  error?: string;
  inlineBytes?: number;
  largeInlineData?: boolean;
}

export interface SessionMediaContext {
  sessionId?: string;
  turnId?: string;
  messageId?: string;
}

export interface CollectSessionMediaAssetsInput extends SessionMediaContext {
  messages?: Message[];
  message?: Message;
}

export const LARGE_INLINE_MEDIA_BYTES = 512 * 1024;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayField(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim());
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] | undefined {
  const unique = Array.from(new Set(values.filter((value): value is string => Boolean(value))));
  return unique.length ? unique : undefined;
}

function basename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] || value;
  const normalized = withoutQuery.replace(/^file:\/\//i, '');
  return normalized.split('/').filter(Boolean).pop() || value;
}

function extensionFromValue(value: string | undefined): string | undefined {
  if (!value || value.startsWith('data:')) return undefined;
  const clean = value.split(/[?#]/, 1)[0] || value;
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase();
}

function kindFromMime(mimeType: string | undefined): SessionMediaKind | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  return undefined;
}

function kindFromExtension(value: string | undefined): SessionMediaKind | undefined {
  const ext = extensionFromValue(value);
  if (!ext) return undefined;
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return undefined;
}

function kindFromAttachment(attachment: MessageAttachment): SessionMediaKind | undefined {
  if (attachment.category === 'image' || attachment.type === 'image') return 'image';
  if (attachment.category === 'video') return 'video';
  if (attachment.category === 'audio') return 'audio';
  return kindFromMime(attachment.mimeType) || kindFromExtension(attachment.name || attachment.path);
}

function kindFromToolName(toolName: string): SessionMediaKind | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.includes('video')) return 'video';
  if (normalized.includes('audio') || normalized.includes('speech')) return 'audio';
  if (normalized.includes('image') || normalized.includes('screenshot') || normalized.includes('ocr')) {
    return 'image';
  }
  return undefined;
}

function mimeFromDataUrl(dataUrl: string | undefined): string | undefined {
  if (!dataUrl?.startsWith('data:')) return undefined;
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  return match?.[1];
}

export function estimateDataUrlBytes(value: string | undefined): number | undefined {
  if (!value?.startsWith('data:')) return undefined;
  const commaIndex = value.indexOf(',');
  if (commaIndex === -1) return undefined;
  const header = value.slice(0, commaIndex).toLowerCase();
  const payload = value.slice(commaIndex + 1);
  if (!header.includes(';base64')) {
    return payload.length;
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function normalizeImageData(value: string | undefined, mimeType = 'image/png'): {
  dataUrl?: string;
  url?: string;
  inlineBytes?: number;
} {
  if (!value?.trim()) return {};
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return { url: trimmed };
  }
  if (
    trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || kindFromExtension(trimmed)
  ) {
    return {};
  }
  const dataUrl = trimmed.startsWith('data:')
    ? trimmed
    : `data:${mimeType};base64,${trimmed}`;
  return {
    dataUrl,
    inlineBytes: estimateDataUrlBytes(dataUrl),
  };
}

function fingerprint(value: string): string {
  if (value.length <= 48) return value;
  return `${value.length}:${value.slice(0, 24)}:${value.slice(-16)}`;
}

function dedupeKeyForAsset(asset: SessionMediaAsset): string {
  if (asset.path) return `path:${asset.path}`;
  if (asset.url) return `url:${asset.url}`;
  if (asset.dataUrl) return `data:${fingerprint(asset.dataUrl)}`;
  if (asset.thumbnailUrl) return `thumb:${fingerprint(asset.thumbnailUrl)}`;
  return `id:${asset.assetId}`;
}

function roleScore(role: SessionMediaRole): number {
  if (role === 'output') return 3;
  if (role === 'intermediate') return 2;
  return 1;
}

function stateScore(state: SessionMediaState): number {
  if (state === 'ready') return 3;
  if (state === 'pending') return 2;
  return 1;
}

function sourceRefKey(ref: SessionMediaSourceRef): string {
  return [
    ref.source,
    ref.role,
    ref.sessionId,
    ref.turnId,
    ref.messageId,
    ref.toolCallId,
    ref.attachmentId,
    ref.artifactId,
  ].join(':');
}

function withInlineRisk(asset: SessionMediaAsset): SessionMediaAsset {
  const inlineBytes = asset.inlineBytes ?? estimateDataUrlBytes(asset.dataUrl);
  return {
    ...asset,
    inlineBytes,
    largeInlineData: inlineBytes !== undefined && inlineBytes > LARGE_INLINE_MEDIA_BYTES,
  };
}

function buildAssetId(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .join(':')
    .replace(/[^a-zA-Z0-9:_./-]+/g, '_');
}

function mergeAsset(existing: SessionMediaAsset, incoming: SessionMediaAsset): SessionMediaAsset {
  const sourceMap = new Map(existing.sources.map((source) => [sourceRefKey(source), source]));
  for (const source of incoming.sources) {
    sourceMap.set(sourceRefKey(source), source);
  }

  const merged: SessionMediaAsset = {
    ...existing,
    state: stateScore(incoming.state) > stateScore(existing.state) ? incoming.state : existing.state,
    role: roleScore(incoming.role) > roleScore(existing.role) ? incoming.role : existing.role,
    source: existing.source,
    sources: Array.from(sourceMap.values()),
    mimeType: existing.mimeType || incoming.mimeType,
    url: existing.url || incoming.url,
    path: existing.path || incoming.path,
    dataUrl: existing.dataUrl || incoming.dataUrl,
    thumbnailUrl: existing.thumbnailUrl || incoming.thumbnailUrl,
    filename: existing.filename || incoming.filename,
    sizeBytes: existing.sizeBytes || incoming.sizeBytes,
    width: existing.width || incoming.width,
    height: existing.height || incoming.height,
    durationMs: existing.durationMs || incoming.durationMs,
    prompt: existing.prompt || incoming.prompt,
    model: existing.model || incoming.model,
    parentAssetIds: uniqueStrings([...(existing.parentAssetIds || []), ...(incoming.parentAssetIds || [])]),
    error: existing.error || incoming.error,
    inlineBytes: existing.inlineBytes || incoming.inlineBytes,
  };
  return withInlineRisk(merged);
}

function addAsset(target: Map<string, SessionMediaAsset>, asset: SessionMediaAsset | null | undefined): void {
  if (!asset) return;
  const normalized = withInlineRisk(asset);
  const key = dedupeKeyForAsset(normalized);
  const existing = target.get(key);
  target.set(key, existing ? mergeAsset(existing, normalized) : normalized);
}

export function buildAttachmentMediaAsset(
  attachment: MessageAttachment,
  context: SessionMediaContext = {},
): SessionMediaAsset | null {
  const kind = kindFromAttachment(attachment);
  if (!kind) return null;

  const dataUrl = attachment.data?.startsWith('data:') ? attachment.data : undefined;
  const inlineBytes = estimateDataUrlBytes(dataUrl);
  const thumbnailBytes = estimateDataUrlBytes(attachment.thumbnail);
  const safeThumbnail = attachment.thumbnail
    && (thumbnailBytes === undefined || thumbnailBytes <= LARGE_INLINE_MEDIA_BYTES)
    ? attachment.thumbnail
    : undefined;
  const canUseDataUrlAsThumbnail = inlineBytes === undefined || inlineBytes <= LARGE_INLINE_MEDIA_BYTES;
  const thumbnailUrl = safeThumbnail || (dataUrl && !attachment.path && canUseDataUrlAsThumbnail ? dataUrl : undefined);
  const source: SessionMediaSourceRef = {
    source: 'attachment',
    role: 'input',
    sessionId: context.sessionId,
    turnId: context.turnId,
    messageId: context.messageId,
    attachmentId: attachment.id,
    label: attachment.name,
  };

  return withInlineRisk({
    assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'attachment', attachment.id]),
    sessionId: context.sessionId,
    turnId: context.turnId,
    messageId: context.messageId,
    source: 'attachment',
    role: 'input',
    sources: [source],
    kind,
    state: 'ready',
    mimeType: attachment.mimeType,
    path: attachment.path,
    dataUrl,
    thumbnailUrl,
    filename: attachment.name,
    sizeBytes: attachment.size,
    inlineBytes,
  });
}

export function buildMarkdownMediaAsset(
  src: string | undefined,
  alt: string | undefined,
  context: SessionMediaContext = {},
  index = 0,
): SessionMediaAsset | null {
  const rawTarget = src?.trim().replace(/^<|>$/g, '');
  if (!rawTarget) return null;

  const normalized = normalizeImageData(rawTarget);
  const mimeType = mimeFromDataUrl(normalized.dataUrl) || 'image/*';
  const kind = kindFromMime(mimeType) || kindFromExtension(rawTarget);
  if (kind !== 'image') return null;

  const label = alt?.trim() || undefined;
  const source: SessionMediaSourceRef = {
    source: 'markdown',
    role: 'output',
    sessionId: context.sessionId,
    turnId: context.turnId,
    messageId: context.messageId,
    label,
  };

  return withInlineRisk({
    assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'markdown', String(index)]),
    sessionId: context.sessionId,
    turnId: context.turnId,
    messageId: context.messageId,
    source: 'markdown',
    role: 'output',
    sources: [source],
    kind: 'image',
    state: 'ready',
    mimeType,
    url: normalized.url || (/^https?:\/\//i.test(rawTarget) || /^file:\/\//i.test(rawTarget) ? rawTarget : undefined),
    path: !normalized.url && !normalized.dataUrl ? rawTarget : undefined,
    dataUrl: normalized.dataUrl,
    filename: label || basename(rawTarget),
    inlineBytes: normalized.inlineBytes,
  });
}

export function buildArtifactOwnershipMediaAsset(
  item: TurnArtifactOwnershipItem,
  context: SessionMediaContext = {},
): SessionMediaAsset | null {
  const value = item.path || item.url;
  const kind = kindFromExtension(value || item.label);
  if (!value || !kind) return null;

  return mediaAssetFromPathOrUrl({
    value,
    kind,
    filename: item.label,
    sourceRef: {
      source: 'artifact',
      role: 'output',
      sessionId: context.sessionId,
      turnId: context.turnId,
      messageId: context.messageId,
      artifactId: item.sourceNodeId,
      label: item.label,
    },
    assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'artifact', item.sourceNodeId, item.label]),
    context,
  });
}

function markdownImageAssets(message: Message, context: SessionMediaContext): SessionMediaAsset[] {
  if (!message.content) return [];
  const assets: SessionMediaAsset[] = [];
  const markdownImagePattern = /!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = markdownImagePattern.exec(message.content)) !== null) {
    const alt = match[1]?.trim();
    const rawTarget = match[2]?.trim().replace(/^<|>$/g, '');
    const asset = buildMarkdownMediaAsset(rawTarget, alt, { ...context, messageId: message.id }, index);
    if (!asset) continue;
    assets.push(asset);
    index += 1;
  }
  return assets;
}

function mediaAssetFromPathOrUrl(input: {
  value: string | undefined;
  kind?: SessionMediaKind;
  mimeType?: string;
  filename?: string;
  sourceRef: SessionMediaSourceRef;
  assetId: string;
  state?: SessionMediaState;
  error?: string;
  prompt?: string;
  model?: string;
  parentAssetIds?: string[];
  thumbnailUrl?: string;
  sizeBytes?: number;
  context: SessionMediaContext;
}): SessionMediaAsset | null {
  const value = input.value?.trim();
  if (!value) return null;
  const normalized = normalizeImageData(value, input.mimeType);
  const kind = input.kind || kindFromMime(input.mimeType || mimeFromDataUrl(normalized.dataUrl)) || kindFromExtension(value);
  if (!kind) return null;
  const isUrl = /^https?:\/\//i.test(value) || /^file:\/\//i.test(value);

  return withInlineRisk({
    assetId: input.assetId,
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    messageId: input.context.messageId,
    toolCallId: input.sourceRef.toolCallId,
    source: input.sourceRef.source,
    role: input.sourceRef.role,
    sources: [input.sourceRef],
    kind,
    state: input.state || 'ready',
    mimeType: input.mimeType || mimeFromDataUrl(normalized.dataUrl),
    url: normalized.url || (isUrl ? value : undefined),
    path: !isUrl && !normalized.dataUrl ? value : undefined,
    dataUrl: normalized.dataUrl,
    thumbnailUrl: input.thumbnailUrl,
    filename: input.filename || basename(value),
    sizeBytes: input.sizeBytes,
    prompt: input.prompt,
    model: input.model,
    parentAssetIds: input.parentAssetIds,
    error: input.error,
    inlineBytes: normalized.inlineBytes,
  });
}

function parentRefsFromMetadata(metadata: Record<string, unknown> | undefined, outputPath?: string): string[] | undefined {
  if (!metadata) return undefined;
  const inputCandidates = [
    stringField(metadata, 'inputPath'),
    stringField(metadata, 'input_path'),
    stringField(metadata, 'sourcePath'),
    stringField(metadata, 'imagePath'),
    ...stringArrayField(metadata, 'inputPaths'),
    ...stringArrayField(metadata, 'input_paths'),
    ...stringArrayField(metadata, 'sourcePaths'),
    ...stringArrayField(metadata, 'source_paths'),
    ...stringArrayField(metadata, 'imagePaths'),
    ...stringArrayField(metadata, 'image_paths'),
  ].filter((value): value is string => Boolean(value && value !== outputPath));
  return uniqueStrings(inputCandidates.map((value) => `path:${value}`));
}

export function buildToolResultMediaAssets(
  toolCall: ToolCall,
  context: SessionMediaContext = {},
): SessionMediaAsset[] {
  const assets = new Map<string, SessionMediaAsset>();
  const metadata = toolCall.result?.metadata;
  const toolKind = kindFromToolName(toolCall.name);
  const baseSource: Omit<SessionMediaSourceRef, 'source' | 'role'> = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    messageId: context.messageId,
    toolCallId: toolCall.id,
    label: toolCall.name,
  };

  if (!toolCall.result && toolKind) {
    addAsset(assets, {
      assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'tool', toolCall.id, 'pending']),
      sessionId: context.sessionId,
      turnId: context.turnId,
      messageId: context.messageId,
      toolCallId: toolCall.id,
      source: 'tool_result',
      role: 'output',
      sources: [{ ...baseSource, source: 'tool_result', role: 'output' }],
      kind: toolKind,
      state: 'pending',
      filename: `${toolCall.name} result`,
    });
    return Array.from(assets.values());
  }

  if (toolCall.result && !toolCall.result.success && toolKind) {
    addAsset(assets, {
      assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'tool', toolCall.id, 'failed']),
      sessionId: context.sessionId,
      turnId: context.turnId,
      messageId: context.messageId,
      toolCallId: toolCall.id,
      source: 'tool_result',
      role: 'output',
      sources: [{ ...baseSource, source: 'tool_result', role: 'output' }],
      kind: toolKind,
      state: 'failed',
      filename: `${toolCall.name} result`,
      error: toolCall.result.error || (typeof toolCall.result.output === 'string' ? toolCall.result.output : undefined),
    });
    return Array.from(assets.values());
  }

  if (!toolCall.result?.success || !metadata) {
    return [];
  }

  const originalPrompt = stringField(metadata, 'originalPrompt') || stringField(metadata, 'prompt');
  const expandedPrompt = stringField(metadata, 'expandedPrompt');
  const model = stringField(metadata, 'model') || stringField(metadata, 'engine');
  const imageMime = stringField(metadata, 'mimeType') || 'image/png';
  const imagePath = stringField(metadata, 'imagePath');
  const imageBase64 = stringField(metadata, 'imageBase64');
  const annotatedPath = stringField(metadata, 'annotatedPath');
  const videoPath = stringField(metadata, 'videoPath');
  const videoUrl = stringField(metadata, 'videoUrl');
  const coverUrl = stringField(metadata, 'coverUrl');
  const outputPath = stringField(metadata, 'outputPath') || toolCall.result.outputPath;

  if (toolCall.name === 'image_generate') {
    const imageSource: SessionMediaSourceRef = { ...baseSource, source: 'tool_result', role: 'output' };
    addAsset(assets, mediaAssetFromPathOrUrl({
      value: imagePath || imageBase64,
      kind: 'image',
      mimeType: imageMime,
      filename: imagePath ? basename(imagePath) : 'generated-image.png',
      sourceRef: imageSource,
      assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'tool', toolCall.id, 'image']),
      prompt: expandedPrompt || originalPrompt,
      model,
      context,
    }));
  } else {
    if (imagePath && kindFromExtension(imagePath) === 'image') {
      const imageRole: SessionMediaRole = annotatedPath || outputPath ? 'input' : 'intermediate';
      addAsset(assets, mediaAssetFromPathOrUrl({
        value: imagePath,
        kind: 'image',
        mimeType: imageMime,
        filename: basename(imagePath),
        sourceRef: { ...baseSource, source: 'tool_result', role: imageRole },
        assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'tool', toolCall.id, 'input-image']),
        context,
      }));
    }
  }

  for (const candidate of [annotatedPath, outputPath]) {
    const kind = kindFromExtension(candidate);
    if (!candidate || !kind) continue;
    addAsset(assets, mediaAssetFromPathOrUrl({
      value: candidate,
      kind,
      filename: basename(candidate),
      sourceRef: { ...baseSource, source: 'tool_result', role: 'output' },
      assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'tool', toolCall.id, basename(candidate)]),
      prompt: expandedPrompt || originalPrompt,
      model,
      parentAssetIds: parentRefsFromMetadata(metadata, candidate),
      context,
    }));
  }

  if (videoPath || videoUrl) {
    addAsset(assets, mediaAssetFromPathOrUrl({
      value: videoPath || videoUrl,
      kind: 'video',
      mimeType: 'video/mp4',
      filename: videoPath ? basename(videoPath) : 'generated-video.mp4',
      sourceRef: { ...baseSource, source: 'tool_result', role: 'output' },
      assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'tool', toolCall.id, 'video']),
      thumbnailUrl: coverUrl,
      prompt: expandedPrompt || originalPrompt,
      model,
      context,
    }));
  }

  for (const artifact of collectToolArtifactsFromMetadata(metadata)) {
    const kind = kindFromMime(artifact.mimeType)
      || (artifact.kind === 'image' || artifact.kind === 'video' || artifact.kind === 'audio'
        ? artifact.kind
        : undefined)
      || kindFromExtension(artifact.path || artifact.url);
    if (!kind) continue;
    addAsset(assets, mediaAssetFromPathOrUrl({
      value: artifact.path || artifact.url,
      kind,
      mimeType: artifact.mimeType,
      filename: artifact.label,
      sourceRef: {
        ...baseSource,
        source: 'artifact',
        role: 'output',
        artifactId: artifact.artifactId,
        label: artifact.label,
      },
      assetId: buildAssetId(['media', context.sessionId, context.turnId, context.messageId, 'artifact', artifact.artifactId || artifact.label]),
      prompt: stringField(artifact.metadata, 'expandedPrompt') || stringField(artifact.metadata, 'originalPrompt') || expandedPrompt || originalPrompt,
      model: stringField(artifact.metadata, 'model') || model,
      parentAssetIds: parentRefsFromMetadata(artifact.metadata, artifact.path || artifact.url),
      sizeBytes: numberField(artifact.metadata, 'sizeBytes'),
      context,
    }));
  }

  return Array.from(assets.values());
}

export function collectSessionMediaAssets(input: CollectSessionMediaAssetsInput): SessionMediaAsset[] {
  const messages = input.messages || (input.message ? [input.message] : []);
  const assets = new Map<string, SessionMediaAsset>();

  for (const message of messages) {
    const context: SessionMediaContext = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      messageId: message.id,
    };

    for (const attachment of message.attachments || []) {
      addAsset(assets, buildAttachmentMediaAsset(attachment, context));
    }

    for (const asset of markdownImageAssets(message, context)) {
      addAsset(assets, asset);
    }

    for (const toolCall of message.toolCalls || []) {
      for (const asset of buildToolResultMediaAssets(toolCall, context)) {
        addAsset(assets, asset);
      }
    }
  }

  return Array.from(assets.values());
}
