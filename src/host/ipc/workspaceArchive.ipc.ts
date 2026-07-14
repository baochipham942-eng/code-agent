// ============================================================================
// Workspace Archive IPC - bundle 导出 / 归档检查 / 演示文稿文本抽取
// ============================================================================
// 从 workspace.ipc.ts 平移抽出（纯代码搬移，无行为变更）。
// workspace.ipc.ts 保留 re-export，注册与测试的导入路径不变。

import path from 'path';
import { promises as fsp } from 'fs';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type {
  PresentationArtifactLocator,
  PresentationPagePreviewResult,
} from '../../shared/contract/artifactLocator';
import { extractPresentationSlideText } from '../../shared/ooxml/presentationPackageIndex';
import { app } from '../platform';
import { getUserConfigDir } from '../config/configPaths';
import { computeArtifactRevision } from '../tools/artifacts/artifactLocatorHost';
import { loadPresentationPackageIndex } from '../tools/artifacts/presentationPackageIndex';
import { convertToScreenshots, isLibreOfficeAvailable } from '../tools/media/ppt/visualReview';

interface WorkspaceBundleFileInput {
  path: string;
  name?: string;
  role?: string;
  mimeType?: string;
  sha256?: string;
}

export interface WorkspaceExportBundlePayload {
  files: WorkspaceBundleFileInput[];
  bundleName?: string;
  manifest?: Record<string, unknown>;
  outputDir?: string;
  workingDirectory?: string | null;
}

interface WorkspaceExportBundleResult {
  filePath: string;
  size: number;
  fileCount: number;
  skippedCount: number;
}

interface WorkspaceArchiveEntry {
  name: string;
  isDirectory: boolean;
  depth: number;
  extension?: string;
}

interface WorkspaceArchiveInspection {
  filePath: string;
  format: 'zip';
  entryCount: number;
  shownCount: number;
  truncated: boolean;
  entries: WorkspaceArchiveEntry[];
}

interface WorkspacePresentationSlide {
  index: number;
  name: string;
  title?: string;
  text: string[];
}

interface WorkspacePresentationInspection {
  filePath: string;
  format: 'pptx';
  slideCount: number;
  shownCount: number;
  truncated: boolean;
  slides: WorkspacePresentationSlide[];
}

function sanitizeBundleName(value: string | undefined): string {
  const base = (value || `deliverables-${Date.now()}`)
    .replace(/\.zip$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || `deliverables-${Date.now()}`}.zip`;
}

function sanitizeZipEntryName(value: string): string {
  const name = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() || 'artifact';
  return name.replace(/[^a-zA-Z0-9._ -]+/g, '-').replace(/^\.+/, '') || 'artifact';
}

function uniqueEntryName(baseName: string, used: Set<string>): string {
  if (!used.has(baseName)) {
    used.add(baseName);
    return baseName;
  }
  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : '';
  let index = 2;
  while (used.has(`${stem}-${index}${ext}`)) {
    index += 1;
  }
  const next = `${stem}-${index}${ext}`;
  used.add(next);
  return next;
}

function resolveBundlePath(filePath: string, workingDirectory?: string | null): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(workingDirectory || process.cwd(), filePath);
}

export async function handleExportBundle(
  payload: WorkspaceExportBundlePayload,
  getAppService?: () => AgentApplicationService | null,
): Promise<WorkspaceExportBundleResult> {
  const fs = await import('fs/promises');
  const JSZip = require('jszip') as new () => {
    file(name: string, data: Buffer | string): void;
    generateAsync(options: { type: 'nodebuffer'; compression?: 'DEFLATE' }): Promise<Buffer>;
  };

  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length === 0) {
    throw new Error('No files provided for export bundle');
  }

  const workingDirectory = payload.workingDirectory?.trim()
    || getAppService?.()?.getWorkingDirectory()
    || process.cwd();
  const zip = new JSZip();
  const usedNames = new Set<string>();
  const manifestFiles: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];

  for (const file of files.slice(0, 100)) {
    if (!file?.path) continue;
    const resolvedPath = resolveBundlePath(file.path, workingDirectory);
    try {
      const data = await fs.readFile(resolvedPath);
      const stat = await fs.stat(resolvedPath);
      const entryName = uniqueEntryName(sanitizeZipEntryName(file.name || resolvedPath), usedNames);
      zip.file(`files/${entryName}`, data);
      manifestFiles.push({
        entry: `files/${entryName}`,
        path: resolvedPath,
        name: file.name,
        role: file.role,
        mimeType: file.mimeType,
        sha256: file.sha256,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch (error) {
      skipped.push({
        path: resolvedPath,
        name: file.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (manifestFiles.length === 0) {
    throw new Error('No readable files were available for export bundle');
  }

  zip.file('manifest.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    workingDirectory,
    ...payload.manifest,
    files: manifestFiles,
    skipped,
  }, null, 2));

  const outputDir = payload.outputDir?.trim() || app.getPath('downloads');
  await fs.mkdir(outputDir, { recursive: true });
  const bundlePath = path.join(outputDir, sanitizeBundleName(payload.bundleName));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(bundlePath, buffer);
  const stat = await fs.stat(bundlePath);

  return {
    filePath: bundlePath,
    size: stat.size,
    fileCount: manifestFiles.length,
    skippedCount: skipped.length,
  };
}

export async function handleInspectArchive(payload: { filePath: string; limit?: number }): Promise<WorkspaceArchiveInspection> {
  const fs = await import('fs/promises');
  const JSZip = require('jszip') as {
    loadAsync(data: Buffer): Promise<{
      files: Record<string, { name: string; dir: boolean }>;
    }>;
  };
  const filePath = payload.filePath;
  if (!/\.zip$/i.test(filePath)) {
    throw new Error('Only .zip archives can be inspected inline');
  }

  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const limit = Math.max(1, Math.min(payload.limit ?? 200, 500));
  const allEntries = Object.values(zip.files)
    .map((entry) => {
      const cleanName = entry.name.replace(/\\/g, '/');
      const segments = cleanName.split('/').filter(Boolean);
      const leaf = segments[segments.length - 1] || cleanName;
      const dot = leaf.lastIndexOf('.');
      return {
        name: cleanName,
        isDirectory: entry.dir,
        depth: Math.max(0, segments.length - 1),
        extension: !entry.dir && dot > 0 ? leaf.slice(dot + 1).toLowerCase() : undefined,
      };
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return {
    filePath,
    format: 'zip',
    entryCount: allEntries.length,
    shownCount: Math.min(allEntries.length, limit),
    truncated: allEntries.length > limit,
    entries: allEntries.slice(0, limit),
  };
}

export async function handleInspectPresentation(payload: { filePath: string; limit?: number }): Promise<WorkspacePresentationInspection> {
  const filePath = payload.filePath;
  if (!/\.pptx$/i.test(filePath)) {
    throw new Error('Only .pptx presentations can be inspected inline');
  }

  const limit = Math.max(1, Math.min(payload.limit ?? 80, 200));
  const { index, zip } = await loadPresentationPackageIndex(filePath);

  const slides: WorkspacePresentationSlide[] = [];
  for (const target of index.slice(0, limit)) {
    const xml = await zip.files[target.slidePartName].async('string');
    const text = extractPresentationSlideText(xml);
    slides.push({
      index: target.displayIndex + 1,
      name: target.slidePartName,
      title: text[0],
      text,
    });
  }

  return {
    filePath,
    format: 'pptx',
    slideCount: index.length,
    shownCount: slides.length,
    truncated: index.length > limit,
    slides,
  };
}

interface PresentationPreviewDependencies {
  cacheRoot?: string;
  libreOfficeAvailable?: () => boolean;
  convert?: (pptxPath: string, outputDir: string) => Promise<string[]>;
}

interface PresentationScreenshotManifest {
  revision: string;
  screenshots: string[];
}

const presentationPreviewInflight = new Map<string, Promise<PresentationPagePreviewResult>>();

async function readCachedScreenshots(
  manifestPath: string,
  revision: string,
  expectedCount: number,
): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as PresentationScreenshotManifest;
    if (parsed.revision !== revision || parsed.screenshots.length !== expectedCount) return null;
    await Promise.all(parsed.screenshots.map((screenshot) => fsp.access(screenshot)));
    return parsed.screenshots;
  } catch {
    return null;
  }
}

async function buildPresentationPagePreview(
  payload: { filePath: string },
  dependencies: PresentationPreviewDependencies,
): Promise<PresentationPagePreviewResult> {
  const filePath = payload.filePath;
  if (!path.isAbsolute(filePath) || filePath.startsWith('//') || !/\.pptx$/i.test(filePath)) {
    throw new Error('Presentation preview requires an absolute local .pptx path');
  }

  const revision = await computeArtifactRevision(filePath);
  const { index, zip } = await loadPresentationPackageIndex(filePath);
  const label = path.basename(filePath);
  const pages = await Promise.all(index.map(async (target) => {
    const text = extractPresentationSlideText(await zip.files[target.slidePartName].async('string'));
    const locator: PresentationArtifactLocator = {
      version: 1,
      artifact: { kind: 'presentation', filePath, revision },
      target: { kind: 'ppt-slide', ...target },
      display: { label, excerpt: text[0] },
    };
    return { locator, title: text[0], text };
  }));

  const libreOfficeAvailable = dependencies.libreOfficeAvailable ?? isLibreOfficeAvailable;
  if (!libreOfficeAvailable()) {
    return { filePath, state: 'libreoffice-missing', pages };
  }

  const cacheRoot = dependencies.cacheRoot
    ?? path.join(getUserConfigDir(), 'cache', 'presentation-page-previews');
  const cacheDir = path.join(cacheRoot, revision.value);
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const cached = await readCachedScreenshots(manifestPath, revision.value, pages.length);
  if (cached) {
    return {
      filePath,
      state: 'ready',
      pages: pages.map((page, displayIndex) => ({ ...page, screenshotPath: cached[displayIndex] })),
    };
  }

  try {
    await fsp.rm(cacheDir, { recursive: true, force: true });
    const outputDir = path.join(cacheDir, 'pages');
    await fsp.mkdir(outputDir, { recursive: true });
    const convert = dependencies.convert ?? convertToScreenshots;
    const screenshots = await convert(filePath, outputDir);
    if (screenshots.length !== pages.length) {
      throw new Error(`Expected ${pages.length} screenshots, received ${screenshots.length}`);
    }
    await fsp.writeFile(manifestPath, JSON.stringify({ revision: revision.value, screenshots }), 'utf8');
    return {
      filePath,
      state: 'ready',
      pages: pages.map((page, displayIndex) => ({ ...page, screenshotPath: screenshots[displayIndex] })),
    };
  } catch (error) {
    await fsp.rm(cacheDir, { recursive: true, force: true });
    return {
      filePath,
      state: 'conversion-failed',
      pages,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** C2c：同 revision 只转换一次；截图数组下标严格绑定 resolver 的 displayIndex。 */
export function handlePreviewPresentation(
  payload: { filePath: string },
  dependencies: PresentationPreviewDependencies = {},
): Promise<PresentationPagePreviewResult> {
  const key = path.resolve(payload.filePath);
  const existing = presentationPreviewInflight.get(key);
  if (existing) return existing;
  const pending = buildPresentationPagePreview(payload, dependencies)
    .finally(() => presentationPreviewInflight.delete(key));
  presentationPreviewInflight.set(key, pending);
  return pending;
}
