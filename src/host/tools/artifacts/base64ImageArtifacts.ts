import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolExecutionResult } from '../types';
import { createFileArtifact } from './artifactMeta';

const BASE64_IMAGE_METADATA_KEYS = [
  'imageBase64',
  'imageDataUrl',
  'base64Image',
  'image_base64',
  'screenshotBase64',
] as const;

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

interface Base64ImagePayload {
  key: string;
  buffer: Buffer;
  mimeType: string;
  extension: string;
  sourceLength: number;
}

interface PersistBase64ImageOptions {
  sourceTool: string;
  workingDirectory: string;
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isImageFilePath(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg)$/i.test(value.split(/[?#]/, 1)[0] || value);
}

function getExistingImagePath(metadata: Record<string, unknown>): string | undefined {
  const imagePath = firstString(metadata.imagePath);
  if (imagePath) return imagePath;

  const genericPath = firstString(metadata.outputPath, metadata.filePath);
  if (genericPath && isImageFilePath(genericPath)) return genericPath;

  const candidates = [
    metadata.artifact,
    ...(Array.isArray(metadata.artifacts) ? metadata.artifacts : []),
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const kind = stringField(candidate, 'kind');
    const mimeType = stringField(candidate, 'mimeType');
    const artifactPath = stringField(candidate, 'path');
    if (artifactPath && (kind === 'image' || mimeType?.startsWith('image/'))) {
      return artifactPath;
    }
  }
  return undefined;
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'tool';
}

function mimeFromDataUrl(value: string): string | undefined {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  return match?.[1]?.toLowerCase();
}

function stripDataUrlPrefix(value: string): string {
  return value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
}

function looksLikeBase64Image(value: string): boolean {
  if (value.startsWith('data:image/') && value.includes(';base64,')) return true;
  if (/^https?:\/\//i.test(value) || value.startsWith('file:')) return false;
  if (value.length < 64) return false;
  return /^[a-zA-Z0-9+/=\s]+$/.test(value);
}

function imagePayloadFromMetadata(metadata: Record<string, unknown>): Base64ImagePayload | undefined {
  for (const key of BASE64_IMAGE_METADATA_KEYS) {
    const raw = metadata[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!looksLikeBase64Image(trimmed)) continue;

    const mimeType = (
      mimeFromDataUrl(trimmed)
      || stringField(metadata, 'imageMimeType')
      || stringField(metadata, 'mimeType')
      || stringField(metadata, 'screenshotMimeType')
      || 'image/png'
    ).toLowerCase();
    const extension = MIME_EXTENSION[mimeType] || 'png';
    const base64 = stripDataUrlPrefix(trimmed).replace(/\s/g, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) continue;

    return {
      key,
      buffer,
      mimeType,
      extension,
      sourceLength: trimmed.length,
    };
  }
  return undefined;
}

function appendArtifactMetadata(
  metadata: Record<string, unknown>,
  artifact: unknown,
): Record<string, unknown> {
  const existingArtifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : [];
  const hasExistingArtifact = isRecord(metadata.artifact);
  return {
    ...metadata,
    artifact: metadata.artifact ?? artifact,
    artifacts: hasExistingArtifact
      ? [...existingArtifacts, artifact]
      : [artifact, ...existingArtifacts],
  };
}

function removePersistedBase64Fields(
  metadata: Record<string, unknown>,
  persistedKey: string,
): Record<string, unknown> {
  const next = { ...metadata };
  for (const key of BASE64_IMAGE_METADATA_KEYS) {
    if (key === persistedKey || typeof next[key] === 'string') {
      delete next[key];
    }
  }
  return next;
}

export async function persistBase64ImageMetadata(
  result: ToolExecutionResult,
  options: PersistBase64ImageOptions,
): Promise<ToolExecutionResult> {
  if (!result.metadata) {
    return result;
  }

  const existingImagePath = getExistingImagePath(result.metadata);
  const payload = imagePayloadFromMetadata(result.metadata);
  if (!payload) {
    return result;
  }

  if (existingImagePath) {
    return {
      ...result,
      metadata: {
        ...removePersistedBase64Fields(result.metadata, payload.key),
        imagePath: existingImagePath,
        imageBase64Persisted: false,
        imageBase64Omitted: true,
      },
    };
  }

  try {
    const dir = path.resolve(options.workingDirectory, '.code-agent/artifacts/images');
    await fs.mkdir(dir, { recursive: true });
    const safeTool = sanitizeToolName(options.sourceTool);
    const filePath = path.join(dir, `${safeTool}-${Date.now()}.${payload.extension}`);
    await fs.writeFile(filePath, payload.buffer);

    const artifact = await createFileArtifact(filePath, options.sourceTool, options.sessionId ? { sessionId: options.sessionId } : undefined, {
      kind: 'image',
      mimeType: payload.mimeType,
      sizeBytes: payload.buffer.length,
      metadata: {
        autoPersisted: true,
        sourceMetadataKey: payload.key,
        sourceBase64Length: payload.sourceLength,
      },
    });

    const metadataWithoutBase64 = removePersistedBase64Fields(result.metadata, payload.key);
    return {
      ...result,
      outputPath: result.outputPath ?? filePath,
      metadata: {
        ...appendArtifactMetadata(metadataWithoutBase64, artifact),
        imagePath: metadataWithoutBase64.imagePath ?? filePath,
        outputPath: metadataWithoutBase64.outputPath ?? filePath,
        imageBase64Persisted: true,
        imageBase64Omitted: true,
      },
    };
  } catch (error) {
    const metadataWithoutBase64 = removePersistedBase64Fields(result.metadata, payload.key);
    return {
      ...result,
      metadata: {
        ...metadataWithoutBase64,
        imageBase64Persisted: false,
        imageBase64Omitted: true,
        imageEvidenceStatus: 'blocked',
        imageBase64PersistError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
