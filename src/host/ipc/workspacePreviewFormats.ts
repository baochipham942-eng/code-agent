// ============================================================================
// Side-panel preview for text, HEIC, and legacy Office (doc/ppt/key/pages/numbers).
// Shell tools run through execFile argument arrays. Non-darwin degrades.
// ============================================================================

import { createHash } from 'crypto';
import { execFile as execFileCb } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import { getUserDataPath } from '../platform/appPaths';
import { convertOfficeToPdf, isLibreOfficeAvailable, rasterizePdfToImages } from '../tools/media/officeRaster';
import { PREVIEW_FORMAT_CACHE_DIRNAME } from './previewFormatCacheName';

const SNIFF_BYTES = 8 * 1024;
const TEXT_PREVIEW_CAP_BYTES = 512 * 1024;
const LEGACY_OFFICE_MAX_PAGES = 30;
const SIPS_TIMEOUT_MS = 30_000;

const LEGACY_OFFICE_EXTENSIONS = new Set(['doc', 'ppt', 'key', 'pages', 'numbers']);
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);

const BINARY_MAGICS: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x25, 0x50, 0x44, 0x46],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x1f, 0x8b],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x00, 0x61, 0x73, 0x6d],
  [0xd0, 0xcf, 0x11, 0xe0],
  [0x49, 0x49, 0x2a, 0x00],
  [0x4d, 0x4d, 0x00, 0x2a],
];

interface ClassifyPreviewResult {
  filePath: string;
  classification: 'text' | 'binary';
}

interface TextPreviewResult {
  kind: 'text-preview';
  text: string;
  truncated: boolean;
  fallback?: { code: 'binary' };
}

interface HeicPreviewResult {
  filePath: string;
  state: 'ready' | 'error';
  imagePath?: string;
  code?: 'heic-failed';
}

interface LegacyOfficePage {
  index: number;
  imagePath: string;
}

interface LegacyOfficePreviewResult {
  filePath: string;
  state: 'ready' | 'libreoffice-missing' | 'conversion-failed';
  pages?: LegacyOfficePage[];
}

type PreviewExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<void>;

interface HeicPreviewDependencies {
  platform?: NodeJS.Platform;
  execFile?: PreviewExecFile;
  cacheRoot?: string;
}

interface LegacyOfficePreviewDependencies {
  platform?: NodeJS.Platform;
  libreOfficeAvailable?: () => boolean;
  convertOfficeToPdf?: (inputPath: string, pdfDir: string) => Promise<string>;
  rasterizePdfToImages?: (
    pdfPath: string,
    outputDir: string,
    baseName: string,
    options: { maxPages?: number },
  ) => Promise<string[]>;
  cacheRoot?: string;
}

function assertAbsolute(filePath: unknown): string {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.startsWith('//')) {
    throw new Error('Preview requires an absolute file path');
  }
  return filePath;
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function defaultCacheRoot(): string {
  return path.join(getUserDataPath(), 'cache', PREVIEW_FORMAT_CACHE_DIRNAME);
}

function cacheKey(filePath: string, size: number, mtimeMs: number): string {
  const digest = createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 24);
  return `${digest}-${size}-${Math.trunc(mtimeMs)}`;
}

function startsWithBytes(buf: Buffer, magic: readonly number[]): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

function hasBinaryMagic(buf: Buffer): boolean {
  if (BINARY_MAGICS.some((magic) => startsWithBytes(buf, magic))) return true;
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return true;
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return true;
  }
  if (buf.toString('ascii', 0, 15) === 'SQLite format 3') return true;
  return false;
}

function trimIncompleteUtf8Tail(buf: Buffer): number {
  const len = buf.length;
  if (len === 0) return 0;
  let i = len - 1;
  let cont = 0;
  while (i >= 0 && i >= len - 4 && (buf[i] & 0xc0) === 0x80) {
    cont += 1;
    i -= 1;
  }
  if (i < 0 || cont === 0) return len;
  const lead = buf[i];
  const need = (lead & 0xe0) === 0xc0 ? 1
    : (lead & 0xf0) === 0xe0 ? 2
      : (lead & 0xf8) === 0xf0 ? 3
        : 0;
  if (need === 0 || cont < need) return need === 0 ? len : i;
  if (cont < need) return i;
  return len;
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, trimIncompleteUtf8Tail(buf)));
    return true;
  } catch {
    return false;
  }
}

function classifyBuffer(buf: Buffer): 'text' | 'binary' {
  if (buf.length === 0) return 'text';
  if (buf.includes(0)) return 'binary';
  if (hasBinaryMagic(buf)) return 'binary';
  if (!isValidUtf8(buf)) return 'binary';
  return 'text';
}

async function readPrefix(filePath: string, maxBytes: number): Promise<{ buf: Buffer; size: number }> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    if (toRead > 0) await handle.read(buf, 0, toRead, 0);
    return { buf, size: stat.size };
  } finally {
    await handle.close();
  }
}

export async function classifyPreviewFile(payload: { filePath?: string }): Promise<ClassifyPreviewResult> {
  const filePath = assertAbsolute(payload?.filePath);
  const { buf, size } = await readPrefix(filePath, SNIFF_BYTES);
  if (size === 0) return { filePath, classification: 'text' };
  return { filePath, classification: classifyBuffer(buf) };
}

export async function readTextPreview(payload: { filePath?: string }): Promise<TextPreviewResult> {
  const filePath = assertAbsolute(payload?.filePath);
  const { buf, size } = await readPrefix(filePath, TEXT_PREVIEW_CAP_BYTES);
  if (size === 0) return { kind: 'text-preview', text: '', truncated: false };
  const sniff = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  if (classifyBuffer(sniff) === 'binary') {
    return { kind: 'text-preview', text: '', truncated: false, fallback: { code: 'binary' } };
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, trimIncompleteUtf8Tail(buf)));
  return { kind: 'text-preview', text, truncated: size > TEXT_PREVIEW_CAP_BYTES };
}

function defaultSips(file: string, args: readonly string[], options: { timeout: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args as string[], { timeout: options.timeout }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function previewHeic(
  payload: { filePath?: string },
  dependencies: HeicPreviewDependencies = {},
): Promise<HeicPreviewResult> {
  const filePath = assertAbsolute(payload?.filePath);
  const failed: HeicPreviewResult = { filePath, state: 'error', code: 'heic-failed' };
  if (!HEIC_EXTENSIONS.has(extensionOf(filePath))) return failed;
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin') return failed;

  const stat = await fsp.stat(filePath);
  const cacheRoot = dependencies.cacheRoot ?? defaultCacheRoot();
  const imagePath = path.join(cacheRoot, 'heic', `${cacheKey(filePath, stat.size, stat.mtimeMs)}.jpg`);
  try {
    const cached = await fsp.stat(imagePath);
    if (cached.size > 0) return { filePath, state: 'ready', imagePath };
  } catch {
    // cache miss
  }

  await fsp.mkdir(path.dirname(imagePath), { recursive: true });
  const exec = dependencies.execFile ?? defaultSips;
  try {
    await exec('sips', ['-s', 'format', 'jpeg', filePath, '--out', imagePath], { timeout: SIPS_TIMEOUT_MS });
    const written = await fsp.stat(imagePath);
    if (written.size <= 0) return failed;
    return { filePath, state: 'ready', imagePath };
  } catch {
    await fsp.rm(imagePath, { force: true }).catch(() => undefined);
    return failed;
  }
}

interface OfficeManifest {
  size: number;
  mtimeMs: number;
  pages: string[];
}

async function readOfficeCache(manifestPath: string, size: number, mtimeMs: number): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as OfficeManifest;
    if (parsed.size !== size || parsed.mtimeMs !== Math.trunc(mtimeMs) || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      return null;
    }
    await Promise.all(parsed.pages.map((page) => fsp.access(page)));
    return parsed.pages;
  } catch {
    return null;
  }
}

export async function previewLegacyOffice(
  payload: { filePath?: string },
  dependencies: LegacyOfficePreviewDependencies = {},
): Promise<LegacyOfficePreviewResult> {
  const filePath = assertAbsolute(payload?.filePath);
  if (!LEGACY_OFFICE_EXTENSIONS.has(extensionOf(filePath))) {
    return { filePath, state: 'conversion-failed' };
  }
  const platform = dependencies.platform ?? process.platform;
  const available = dependencies.libreOfficeAvailable ?? isLibreOfficeAvailable;
  if (platform !== 'darwin' || !available()) {
    return { filePath, state: 'libreoffice-missing' };
  }

  const stat = await fsp.stat(filePath);
  const cacheRoot = dependencies.cacheRoot ?? path.join(defaultCacheRoot(), 'office');
  const dir = path.join(cacheRoot, cacheKey(filePath, stat.size, stat.mtimeMs));
  const manifestPath = path.join(dir, 'manifest.json');
  const cached = await readOfficeCache(manifestPath, stat.size, stat.mtimeMs);
  if (cached) {
    return {
      filePath,
      state: 'ready',
      pages: cached.map((imagePath, index) => ({ index: index + 1, imagePath })),
    };
  }

  const convert = dependencies.convertOfficeToPdf ?? convertOfficeToPdf;
  const rasterize = dependencies.rasterizePdfToImages ?? rasterizePdfToImages;
  const pdfDir = path.join(dir, 'pdf');
  const pagesDir = path.join(dir, 'pages');
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(pdfDir, { recursive: true });
    await fsp.mkdir(pagesDir, { recursive: true });
    const pdfPath = await convert(filePath, pdfDir);
    const images = await rasterize(pdfPath, pagesDir, 'page', { maxPages: LEGACY_OFFICE_MAX_PAGES });
    if (images.length === 0) {
      await fsp.rm(dir, { recursive: true, force: true });
      return { filePath, state: 'conversion-failed' };
    }
    const pages = images.slice(0, LEGACY_OFFICE_MAX_PAGES);
    await fsp.writeFile(manifestPath, JSON.stringify({
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      pages,
    }));
    return {
      filePath,
      state: 'ready',
      pages: pages.map((imagePath, index) => ({ index: index + 1, imagePath })),
    };
  } catch {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { filePath, state: 'conversion-failed' };
  }
}

