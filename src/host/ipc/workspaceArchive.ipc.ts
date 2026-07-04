// ============================================================================
// Workspace Archive IPC - bundle 导出 / 归档检查 / 演示文稿文本抽取
// ============================================================================
// 从 workspace.ipc.ts 平移抽出（纯代码搬移，无行为变更）。
// workspace.ipc.ts 保留 re-export，注册与测试的导入路径不变。

import path from 'path';
import { promises as fsp } from 'fs';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { app } from '../platform';

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

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function slideIndexFromName(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/i);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function extractSlideText(xml: string): string[] {
  const texts: string[] = [];
  const textRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const text = decodeXmlText(match[1].replace(/<[^>]+>/g, '')).trim();
    if (text) texts.push(text);
  }
  return texts;
}

export async function handleInspectPresentation(payload: { filePath: string; limit?: number }): Promise<WorkspacePresentationInspection> {
  const fs = await import('fs/promises');
  const JSZip = require('jszip') as {
    loadAsync(data: Buffer): Promise<{
      files: Record<string, { name: string; dir: boolean; async(type: 'string'): Promise<string> }>;
    }>;
  };
  const filePath = payload.filePath;
  if (!/\.pptx$/i.test(filePath)) {
    throw new Error('Only .pptx presentations can be inspected inline');
  }

  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const limit = Math.max(1, Math.min(payload.limit ?? 80, 200));
  const slideEntries = Object.values(zip.files)
    .filter((entry) => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((left, right) => slideIndexFromName(left.name) - slideIndexFromName(right.name));

  const slides: WorkspacePresentationSlide[] = [];
  for (const [offset, entry] of slideEntries.slice(0, limit).entries()) {
    const xml = await entry.async('string');
    const text = extractSlideText(xml);
    slides.push({
      index: offset + 1,
      name: entry.name,
      title: text[0],
      text,
    });
  }

  return {
    filePath,
    format: 'pptx',
    slideCount: slideEntries.length,
    shownCount: slides.length,
    truncated: slideEntries.length > limit,
    slides,
  };
}

