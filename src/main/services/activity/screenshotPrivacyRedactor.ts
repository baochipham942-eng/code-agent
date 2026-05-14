import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { sanitizeLocalActivityText } from './localActivityPrivacyFirewall';

export interface ScreenshotRedactionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  normalized?: boolean;
  text?: string;
  source?: 'explicit' | 'ocr';
}

export interface ScreenshotRedactionResult {
  redacted: boolean;
  outputPath: string;
  reason: string;
  regions: number;
}

export interface ScreenshotRedactionOptions {
  regions?: ScreenshotRedactionRegion[];
  fullFrame?: boolean;
  reason?: string;
  blurSigma?: number;
  overwrite?: boolean;
}

const DEFAULT_BLUR_SIGMA = 24;
const MAX_REGION_SCAN_DEPTH = 8;
type ClampedScreenshotRedactionRegion = Pick<ScreenshotRedactionRegion, 'x' | 'y' | 'width' | 'height'>;

export function shouldRedactScreenshotFromText(text: string): boolean {
  return sanitizeLocalActivityText(text) !== text.trim();
}

export function selectScreenshotRedactionRegions(
  metadata: unknown,
  analysisText?: string,
): ScreenshotRedactionRegion[] {
  const regions = extractScreenshotRedactionRegions(metadata);
  if (regions.length === 0) return [];

  const textSensitiveRegions = regions.filter((region) =>
    region.text ? shouldRedactScreenshotFromText(region.text) : false,
  );
  if (textSensitiveRegions.length > 0) {
    return textSensitiveRegions;
  }

  const explicitRegions = regions.filter((region) => region.source === 'explicit');
  if (explicitRegions.length > 0) {
    return explicitRegions;
  }

  if (analysisText && shouldRedactScreenshotFromText(analysisText)) {
    return regions;
  }

  return [];
}

export function extractScreenshotRedactionRegions(metadata: unknown): ScreenshotRedactionRegion[] {
  const regions: ScreenshotRedactionRegion[] = [];
  collectScreenshotRegions(metadata, null, regions, 0);
  return regions;
}

export async function redactScreenshotFile(
  imagePath: string,
  options: ScreenshotRedactionOptions = {},
): Promise<ScreenshotRedactionResult> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Screenshot not found: ${imagePath}`);
  }

  const metadata = await sharp(imagePath).metadata();
  const imageWidth = metadata.width;
  const imageHeight = metadata.height;
  if (!imageWidth || !imageHeight) {
    throw new Error(`Unable to read screenshot dimensions: ${imagePath}`);
  }

  const outputPath = options.overwrite ? imagePath : buildRedactedScreenshotPath(imagePath);
  const tmpPath = `${outputPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const blurSigma = options.blurSigma ?? DEFAULT_BLUR_SIGMA;

  if (options.fullFrame) {
    await sharp(imagePath).blur(blurSigma).toFile(tmpPath);
    fs.renameSync(tmpPath, outputPath);
    return {
      redacted: true,
      outputPath,
      reason: options.reason || 'full-frame',
      regions: 1,
    };
  }

  const regions = (options.regions || [])
    .map((region) => clampRegion(region, imageWidth, imageHeight))
    .filter((region): region is ClampedScreenshotRedactionRegion => Boolean(region));

  if (regions.length === 0) {
    return {
      redacted: false,
      outputPath: imagePath,
      reason: options.reason || 'no-regions',
      regions: 0,
    };
  }

  const overlays = await Promise.all(regions.map(async (region) => {
    const input = await sharp(imagePath)
      .extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height,
      })
      .blur(blurSigma)
      .toBuffer();
    return {
      input,
      left: region.x,
      top: region.y,
    };
  }));

  await sharp(imagePath).composite(overlays).toFile(tmpPath);
  fs.renameSync(tmpPath, outputPath);

  return {
    redacted: true,
    outputPath,
    reason: options.reason || 'regions',
    regions: regions.length,
  };
}

function buildRedactedScreenshotPath(imagePath: string): string {
  const ext = path.extname(imagePath);
  const base = imagePath.slice(0, imagePath.length - ext.length);
  return `${base}.redacted${ext || '.png'}`;
}

function clampRegion(
  region: ScreenshotRedactionRegion,
  imageWidth: number,
  imageHeight: number,
): ClampedScreenshotRedactionRegion | null {
  const normalized = region.normalized === true || looksLikeNormalizedRegion(region);
  const rawX = normalized ? region.x * imageWidth : region.x;
  const rawY = normalized ? region.y * imageHeight : region.y;
  const rawWidth = normalized ? region.width * imageWidth : region.width;
  const rawHeight = normalized ? region.height * imageHeight : region.height;
  const x = clamp(Math.floor(rawX), 0, imageWidth);
  const y = clamp(Math.floor(rawY), 0, imageHeight);
  const right = clamp(Math.ceil(rawX + rawWidth), 0, imageWidth);
  const bottom = clamp(Math.ceil(rawY + rawHeight), 0, imageHeight);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function collectScreenshotRegions(
  value: unknown,
  source: ScreenshotRedactionRegion['source'] | null,
  regions: ScreenshotRedactionRegion[],
  depth: number,
): void {
  if (value === null || value === undefined || depth > MAX_REGION_SCAN_DEPTH) return;

  if (Array.isArray(value)) {
    const directRegion = source ? parseArrayRegion(value, source) : null;
    if (directRegion) {
      regions.push(directRegion);
      return;
    }
    for (const item of value) {
      collectScreenshotRegions(item, source, regions, depth + 1);
    }
    return;
  }

  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const directRegion = source ? parseObjectRegion(record, source) : null;
  if (directRegion) {
    regions.push(directRegion);
  }

  for (const [key, child] of Object.entries(record)) {
    const childSource = classifyRegionContainer(key) || source;
    if (!childSource && !isOcrLikeContainer(key)) continue;
    collectScreenshotRegions(child, childSource || 'ocr', regions, depth + 1);
  }
}

function parseObjectRegion(
  record: Record<string, unknown>,
  source: ScreenshotRedactionRegion['source'] | null,
): ScreenshotRedactionRegion | null {
  const nestedBox = record.bbox ?? record.box ?? record.bounds ?? record.rect;
  if (nestedBox && !hasNumber(record.x) && !hasNumber(record.left)) {
    const parsed = Array.isArray(nestedBox)
      ? parseArrayRegion(nestedBox, source)
      : typeof nestedBox === 'object'
        ? parseObjectRegion(nestedBox as Record<string, unknown>, source)
        : null;
    return parsed ? withRegionMeta(parsed, record, source) : null;
  }

  const x = numberValue(record.x ?? record.left);
  const y = numberValue(record.y ?? record.top);
  const width = numberValue(record.width ?? record.w);
  const height = numberValue(record.height ?? record.h);
  if (x !== null && y !== null && width !== null && height !== null) {
    return withRegionMeta({ x, y, width, height }, record, source);
  }

  const x1 = numberValue(record.x1 ?? record.left);
  const y1 = numberValue(record.y1 ?? record.top);
  const x2 = numberValue(record.x2 ?? record.right);
  const y2 = numberValue(record.y2 ?? record.bottom);
  if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
    return withRegionMeta({
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    }, record, source);
  }

  return null;
}

function parseArrayRegion(
  value: unknown[],
  source: ScreenshotRedactionRegion['source'] | null,
): ScreenshotRedactionRegion | null {
  const numbers = value.map(numberValue).filter((item): item is number => item !== null);
  if (numbers.length === 4) {
    return {
      x: numbers[0],
      y: numbers[1],
      width: numbers[2],
      height: numbers[3],
      source: source || 'ocr',
    };
  }

  if (numbers.length >= 8 && numbers.length % 2 === 0) {
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      source: source || 'ocr',
    };
  }

  return null;
}

function withRegionMeta(
  region: ScreenshotRedactionRegion,
  record: Record<string, unknown>,
  source: ScreenshotRedactionRegion['source'] | null,
): ScreenshotRedactionRegion {
  const normalized = record.normalized === true || record.unit === 'ratio' || record.unit === 'normalized';
  const text = textValue(record.text ?? record.rawText ?? record.content ?? record.value);
  return {
    ...region,
    normalized: normalized || region.normalized,
    source: source || region.source || 'ocr',
    text: text || region.text,
  };
}

function classifyRegionContainer(key: string): ScreenshotRedactionRegion['source'] | null {
  if (/^(redactionRegions|redaction_regions|sensitiveRegions|sensitive_regions|sensitiveTextRegions|sensitive_text_regions)$/i.test(key)) {
    return 'explicit';
  }
  if (/^(ocrRegions|ocr_regions|textRegions|text_regions|ocrBoxes|ocr_boxes|textBoxes|text_boxes)$/i.test(key)) {
    return 'ocr';
  }
  return null;
}

function isOcrLikeContainer(key: string): boolean {
  return /^(ocr|ocrResult|ocrResults|vision|visionResult|visionResults)$/i.test(key);
}

function looksLikeNormalizedRegion(region: ScreenshotRedactionRegion): boolean {
  const values = [region.x, region.y, region.width, region.height];
  const hasFractionalRatio = values.some((value) => value > 0 && value < 1 && !Number.isInteger(value));
  if (!hasFractionalRatio) return false;
  return region.x >= 0
    && region.y >= 0
    && region.width > 0
    && region.height > 0
    && region.x + region.width <= 1.05
    && region.y + region.height <= 1.05;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasNumber(value: unknown): boolean {
  return numberValue(value) !== null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
