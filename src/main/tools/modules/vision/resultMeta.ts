import * as path from 'path';
import type { ToolResult, ToolContext } from '../../../protocol/tools';
import type { ToolExecutionResult } from '../../types';
import type { ToolArtifact, ToolArtifactKind } from '../../../../shared/contract/artifactBlob';
import { createFileArtifact, createVirtualArtifact, inferArtifactKind } from '../../artifacts/artifactMeta';
import { adaptLegacyResult } from '../_helpers/legacyAdapter';

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie|base64)/i;
const CONTENT_KEY_PATTERN = /(content|text|prompt|task|value)/i;
const STRING_PREVIEW_LIMIT = 160;
const CONTENT_PREVIEW_LIMIT = 500;

type JsonRecord = Record<string, unknown>;

interface VisionResultMetaOptions {
  tool: string;
  args: Record<string, unknown>;
  ctx: Pick<ToolContext, 'sessionId'>;
  defaultAction?: string;
  target?: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return { redacted: true, length: value.length };
    }
    if (CONTENT_KEY_PATTERN.test(key)) {
      return { type: 'string', length: value.length };
    }
    if (value.length > STRING_PREVIEW_LIMIT) {
      return { type: 'string', length: value.length, preview: value.slice(0, STRING_PREVIEW_LIMIT) };
    }
    return value;
  }

  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [childKey, summarizeValue(childKey, childValue)])
        .filter(([, childValue]) => childValue !== undefined),
    );
  }

  return { type: typeof value };
}

function buildRequestSummary(args: Record<string, unknown>): JsonRecord {
  return {
    args: Object.fromEntries(
      Object.entries(args)
        .map(([key, value]) => [key, summarizeValue(key, value)])
        .filter(([, value]) => value !== undefined),
    ),
  };
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function inferAction(tool: string, args: Record<string, unknown>, fallback?: string): string | undefined {
  const action = stringFrom(args.action);
  if (action) return action;
  if (fallback) return fallback;
  if (tool === 'screenshot') return 'capture';
  if (tool === 'gui_agent') return 'run';
  return undefined;
}

function inferTarget(args: Record<string, unknown>, metadata: JsonRecord, fallback?: unknown): unknown {
  return fallback
    ?? args.target
    ?? args.url
    ?? args.targetApp
    ?? args.browser
    ?? metadata.target
    ?? metadata.url;
}

function isToolArtifactKind(value: unknown): value is ToolArtifactKind {
  return typeof value === 'string' && [
    'text',
    'binary',
    'image',
    'audio',
    'video',
    'document',
    'spreadsheet',
    'web',
    'search',
    'process-output',
    'process-log',
  ].includes(value);
}

function inferArtifactKindFromSummary(summary: JsonRecord): ToolArtifactKind {
  const mimeType = stringFrom(summary.mimeType);
  const artifactPath = stringFrom(summary.artifactPath);
  const name = stringFrom(summary.name);
  if (isToolArtifactKind(summary.kind)) return summary.kind;
  if (mimeType || artifactPath || name) {
    return inferArtifactKind(artifactPath ?? name ?? 'artifact.bin', mimeType ?? undefined);
  }
  return 'binary';
}

function normalizeArtifact(value: unknown, tool: string, ctx: Pick<ToolContext, 'sessionId'>): ToolArtifact | null {
  if (!isRecord(value) || typeof value.artifactId !== 'string') return null;

  const kind = inferArtifactKindFromSummary(value);
  return {
    artifactId: value.artifactId,
    kind,
    sourceTool: stringFrom(value.sourceTool) ?? tool,
    createdAt: stringFrom(value.createdAt) ?? (
      typeof value.createdAtMs === 'number'
        ? new Date(value.createdAtMs).toISOString()
        : new Date().toISOString()
    ),
    sessionId: stringFrom(value.sessionId) ?? ctx.sessionId,
    name: stringFrom(value.name),
    path: stringFrom(value.path),
    url: stringFrom(value.url),
    mimeType: stringFrom(value.mimeType),
    sizeBytes: typeof value.sizeBytes === 'number'
      ? value.sizeBytes
      : typeof value.size === 'number'
        ? value.size
        : undefined,
    sha256: stringFrom(value.sha256),
    contentLength: typeof value.contentLength === 'number' ? value.contentLength : undefined,
    preview: stringFrom(value.preview),
    metadata: {
      ...(isRecord(value.metadata) ? value.metadata : {}),
      legacyArtifact: value,
    },
  };
}

function artifactKey(artifact: ToolArtifact): string {
  return artifact.path ?? artifact.url ?? artifact.artifactId;
}

function pushArtifact(artifacts: ToolArtifact[], seen: Set<string>, artifact: ToolArtifact): void {
  const key = artifactKey(artifact);
  if (seen.has(key)) return;
  seen.add(key);
  artifacts.push(artifact);
}

async function addFileArtifact(
  artifacts: ToolArtifact[],
  seen: Set<string>,
  filePath: string | undefined,
  tool: string,
  ctx: Pick<ToolContext, 'sessionId'>,
  sourceKey: string,
): Promise<void> {
  if (!filePath) return;
  if (/^https?:\/\//i.test(filePath) || filePath.startsWith('data:')) return;

  const artifact = await createFileArtifact(filePath, tool, ctx, {
    metadata: { sourceKey },
  });
  pushArtifact(artifacts, seen, artifact);
}

async function addFileArtifactFromRecord(
  artifacts: ToolArtifact[],
  seen: Set<string>,
  record: unknown,
  key: string,
  tool: string,
  ctx: Pick<ToolContext, 'sessionId'>,
): Promise<void> {
  if (!isRecord(record)) return;
  await addFileArtifact(artifacts, seen, stringFrom(record[key]), tool, ctx, key);
}

function addUrlArtifact(
  artifacts: ToolArtifact[],
  seen: Set<string>,
  url: string | undefined,
  tool: string,
  ctx: Pick<ToolContext, 'sessionId'>,
  content?: string,
): void {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const artifact = createVirtualArtifact({
    sourceTool: tool,
    kind: 'web',
    sessionId: ctx.sessionId,
    url,
    name: url,
    mimeType: content ? 'text/plain' : undefined,
    contentLength: content?.length,
    preview: content ? content.slice(0, CONTENT_PREVIEW_LIMIT) : undefined,
    metadata: { sourceKey: content ? 'url+content' : 'url' },
  });
  pushArtifact(artifacts, seen, artifact);
}

function addContentArtifact(
  artifacts: ToolArtifact[],
  seen: Set<string>,
  content: string | undefined,
  tool: string,
  ctx: Pick<ToolContext, 'sessionId'>,
): void {
  if (!content) return;
  const artifact = createVirtualArtifact({
    sourceTool: tool,
    kind: 'text',
    sessionId: ctx.sessionId,
    name: `${tool}-content.txt`,
    mimeType: 'text/plain',
    contentLength: content.length,
    preview: content.slice(0, CONTENT_PREVIEW_LIMIT),
    metadata: { sourceKey: 'content' },
  });
  pushArtifact(artifacts, seen, artifact);
}

async function addBrowserArtifactSummary(
  artifacts: ToolArtifact[],
  seen: Set<string>,
  summary: unknown,
  tool: string,
  ctx: Pick<ToolContext, 'sessionId'>,
): Promise<void> {
  if (!isRecord(summary)) return;

  const artifactPath = stringFrom(summary.artifactPath);
  if (artifactPath && path.isAbsolute(artifactPath)) {
    const artifact = await createFileArtifact(artifactPath, tool, ctx, {
      artifactId: stringFrom(summary.artifactId),
      name: stringFrom(summary.name),
      mimeType: stringFrom(summary.mimeType),
      sha256: stringFrom(summary.sha256),
      sizeBytes: typeof summary.size === 'number' ? summary.size : undefined,
      metadata: { sourceKey: 'browserArtifact', legacyBrowserArtifact: summary },
    });
    pushArtifact(artifacts, seen, artifact);
    return;
  }

  const artifactId = stringFrom(summary.artifactId);
  if (!artifactId) return;

  pushArtifact(artifacts, seen, {
    artifactId,
    kind: inferArtifactKindFromSummary(summary),
    sourceTool: tool,
    createdAt: typeof summary.createdAtMs === 'number'
      ? new Date(summary.createdAtMs).toISOString()
      : new Date().toISOString(),
    sessionId: stringFrom(summary.sessionId) ?? ctx.sessionId,
    name: stringFrom(summary.name) ?? artifactPath,
    mimeType: stringFrom(summary.mimeType),
    sizeBytes: typeof summary.size === 'number' ? summary.size : undefined,
    sha256: stringFrom(summary.sha256),
    metadata: { sourceKey: 'browserArtifact', legacyBrowserArtifact: summary },
  });
}

async function collectArtifacts(
  result: ToolExecutionResult,
  metadata: JsonRecord,
  tool: string,
  ctx: Pick<ToolContext, 'sessionId'>,
): Promise<ToolArtifact[]> {
  const artifacts: ToolArtifact[] = [];
  const seen = new Set<string>();

  const existingArtifact = normalizeArtifact(metadata.artifact, tool, ctx);
  if (existingArtifact) {
    pushArtifact(artifacts, seen, existingArtifact);
  }
  if (Array.isArray(metadata.artifacts)) {
    for (const artifact of metadata.artifacts) {
      const normalized = normalizeArtifact(artifact, tool, ctx);
      if (normalized) pushArtifact(artifacts, seen, normalized);
    }
  }

  await addBrowserArtifactSummary(artifacts, seen, metadata.browserArtifact, tool, ctx);
  if (Array.isArray(metadata.browserArtifacts)) {
    for (const browserArtifact of metadata.browserArtifacts) {
      await addBrowserArtifactSummary(artifacts, seen, browserArtifact, tool, ctx);
    }
  }

  const content = stringFrom(metadata.content);
  const url = stringFrom(metadata.url);
  addUrlArtifact(artifacts, seen, url, tool, ctx, content);

  const fileEntries: Array<[string, unknown]> = [
    ['outputPath', result.outputPath],
    ['outputPath', metadata.outputPath],
    ['screenshotPath', metadata.screenshotPath],
    ['screenshot_path', metadata.screenshot_path],
    ['path', metadata.path],
    ['filePath', metadata.filePath],
    ['file', metadata.file],
    ['storageStatePath', metadata.storageStatePath],
  ];

  for (const [sourceKey, value] of fileEntries) {
    await addFileArtifact(artifacts, seen, stringFrom(value), tool, ctx, sourceKey);
  }

  await addFileArtifactFromRecord(artifacts, seen, metadata.computerSurfaceSnapshot, 'screenshotPath', tool, ctx);
  await addFileArtifactFromRecord(artifacts, seen, metadata.workbenchTrace, 'screenshotPath', tool, ctx);
  if (isRecord(metadata.workbenchTrace)) {
    await addFileArtifactFromRecord(artifacts, seen, metadata.workbenchTrace.before, 'screenshotPath', tool, ctx);
    await addFileArtifactFromRecord(artifacts, seen, metadata.workbenchTrace.after, 'screenshotPath', tool, ctx);
  }
  if (isRecord(metadata.computerSurface)) {
    await addFileArtifactFromRecord(artifacts, seen, metadata.computerSurface.lastSnapshot, 'screenshotPath', tool, ctx);
    if (isRecord(metadata.computerSurface.lastAction)) {
      await addFileArtifactFromRecord(artifacts, seen, metadata.computerSurface.lastAction, 'screenshotPath', tool, ctx);
      await addFileArtifactFromRecord(artifacts, seen, metadata.computerSurface.lastAction.before, 'screenshotPath', tool, ctx);
      await addFileArtifactFromRecord(artifacts, seen, metadata.computerSurface.lastAction.after, 'screenshotPath', tool, ctx);
    }
  }

  if (!url) {
    addContentArtifact(artifacts, seen, content, tool, ctx);
  }

  return artifacts;
}

export async function adaptVisionLegacyResult(
  result: ToolExecutionResult,
  options: VisionResultMetaOptions,
): Promise<ToolResult<string>> {
  const adapted = adaptLegacyResult(result);
  const legacyMetadata = result.metadata ?? {};
  const artifacts = await collectArtifacts(result, legacyMetadata, options.tool, options.ctx);
  const action = inferAction(options.tool, options.args, options.defaultAction);
  const target = inferTarget(options.args, legacyMetadata, options.target);

  return {
    ...adapted,
    meta: {
      ...legacyMetadata,
      tool: options.tool,
      action,
      target,
      request: buildRequestSummary(options.args),
      legacyMetadata,
      ...(artifacts.length > 0 ? { artifact: artifacts[0], artifacts } : {}),
    },
  };
}
