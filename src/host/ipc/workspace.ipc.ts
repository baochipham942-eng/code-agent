// ============================================================================
// Workspace IPC Handlers - workspace:* 通道
// ============================================================================

import type { IpcMain, AppWindow } from '../platform';
import path from 'path';
import { app, dialog } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { IPC_CHANNELS } from '../../shared/ipc/legacy-channels';
import { handleSaveTextToDownloads, handleSaveBinaryToDownloads } from './workspaceSaveExport';
import { htmlToPdf, imageToPdf } from '../services/design/pdfExport';
import {
  handleExportCanvasPptx,
  handleGenerateSlidesDeck,
  handleGenerateSlidesOutline,
  handleGenerateSlidesPreview,
  type GenerateSlidesDeckPayload,
  type GenerateSlidesOutlinePayload,
  type GenerateSlidesPreviewPayload,
} from './workspaceSlidesExport';
import { assertWithinDesignDir } from './workspaceDesignPaths';
import {
  listBrands as registryListBrands,
  saveBrand as registrySaveBrand,
  deleteBrand as registryDeleteBrand,
  setActiveBrand as registrySetActiveBrand,
} from '../services/design/brandRegistry';
import type { BrandContract } from '../../shared/contract/brandContract';
import { extractBrandFromImage as registryExtractBrand } from '../services/design/brandExtract';
import { handleGetConfigScope } from './workspaceConfigScope';
// buildConfigScopeSummary 历史上是 workspace.ipc 的公开导出，保持向后兼容（测试依赖）。
export { buildConfigScopeSummary } from './workspaceConfigScope';
import type { FileInfo, AppSettings } from '../../shared/contract';
import { deriveBridgedVisualModels } from '../../shared/visualModelBridge';
import { getSecureStorage } from '../services/core/secureStorage';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { ConfigService } from '../services';
import { readDesignMdSummary } from '../../design/design-md-loader';
import { IMAGE_MODELS, VIDEO_MODELS } from '../../shared/constants/visualModels';
import { getConfigService } from '../services/core/configService';
import {
  getDashscopeApiKey,
  getZhipuOfficialApiKey,
  getGptImageConfig,
  getMinimaxApiKey,
} from '../services/media/imageGenerationService';
import type { ExpandDirection } from '../services/media/imageGenerationService';
import {
  getCustomModelApiKey,
  listCustomImageModels,
  saveCustomImageModel,
  deleteCustomImageModel,
  setCustomModelApiKey,
} from '../services/media/customImageModelRegistry';
import {
  getCustomVideoModelApiKey,
  listCustomVideoModels,
  saveCustomVideoModel,
  deleteCustomVideoModel,
  setCustomVideoModelApiKey,
} from '../services/media/customVideoModelRegistry';
import { assertSafeDownloadUrl } from '../security/ssrfGuard';
import { promises as fsp } from 'fs';
import { readDesignSettings, updateDesignSettings } from '../services/design/designSettings';
import type { DesignSettings } from '../services/design/designSettings';


// 设计媒介生成 handlers（出图/参考图/标注重绘/导入/局部重绘/扩图/去水印/视频）
// 已抽到 ./workspaceDesignMedia.ipc.ts，此处接回 registerWorkspaceHandlers 的 switch。
import {
  handleResolveDesignDir,
  handleGenerateDesignImage,
  handleEditImageByAnnotation,
  handleImportDesignImage,
  handleEditDesignImage,
  handleExpandDesignImage,
  handleRemoveWatermarkDesignImage,
  handleGenerateDesignVideo,
} from './workspaceDesignMedia.ipc';
// 这些 handler 历史上是 workspace.ipc 的公开导出（测试与 index.ts 依赖），保持向后兼容。
export {
  handleGenerateDesignImage,
  handleEditImageByAnnotation,
  handleExpandDesignImage,
  handleRemoveWatermarkDesignImage,
  handleGenerateDesignVideo,
} from './workspaceDesignMedia.ipc';
// 列出视频模型 + 可用性（D6/D7：复用 providerKeyConfigured；P2 全 dashscope）。
export async function handleListVisualVideoModels(
  getSettings: () => AppSettings | null = () => null,
  isProviderKeyConfigured: (provider: string) => boolean = () => false,
): Promise<{
  models: Array<{ id: string; label: string; provider: string; available: boolean; caps: string[]; minDurationSec: number; maxDurationSec: number; defaultDurationSec: number; source: 'builtin' | 'custom' | 'bridged'; sourceLabel?: string }>;
}> {
  const builtin = VIDEO_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    available: providerKeyConfigured(m.provider),
    caps: [...m.caps],
    minDurationSec: m.minDurationSec,
    maxDurationSec: m.maxDurationSec,
    defaultDurationSec: m.defaultDurationSec,
    source: 'builtin' as const,
  }));
  // 自定义视频模型：available = 该模型是否已配 key（每模型独立 key）。形状对齐内置，
  // custom 无能力/时长元数据，给安全默认（t2v/i2v + 2~15s，默认 5s）。
  const customs = await listCustomVideoModels();
  const customList = customs.map((c) => ({
    id: c.id,
    label: c.label,
    provider: 'custom',
    available: !!getCustomVideoModelApiKey(c.id),
    caps: ['t2v', 'i2v'],
    minDurationSec: 2,
    maxDurationSec: 15,
    defaultDurationSec: 5,
    source: 'custom' as const,
  }));
  // 桥接模型：从已配置聊天 provider 派生带视频生成能力的模型（P1 多模态桥接）。
  const bridged = deriveBridgedVisualModels(getSettings())
    .filter((m) => m.mediaType === 'video')
    .map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.sourceProvider,
      available: isProviderKeyConfigured(m.sourceProvider),
      caps: ['t2v', 'i2v'],
      minDurationSec: 2,
      maxDurationSec: 15,
      defaultDurationSec: 5,
      source: 'bridged' as const,
      sourceLabel: m.sourceLabel,
    }));
  return { models: [...builtin, ...customList, ...bridged] };
}

// 列出音乐生成模型（内置 MiniMax + 桥接派生）。与 image/video 对称，绝不回 key 值。
export async function handleListVisualMusicModels(
  getSettings: () => AppSettings | null = () => null,
  isProviderKeyConfigured: (provider: string) => boolean = () => false,
): Promise<{
  models: Array<{ id: string; label: string; provider: string; available: boolean; source: 'bridged' | 'builtin'; sourceLabel?: string }>;
}> {
  const builtin = [{
    id: 'minimax-music-2.6',
    label: 'MiniMax 音乐',
    provider: 'minimax',
    available: !!getMinimaxApiKey(),
    source: 'builtin' as const,
  }];
  const bridged = deriveBridgedVisualModels(getSettings())
    .filter((m) => m.mediaType === 'music')
    .map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.sourceProvider,
      available: isProviderKeyConfigured(m.sourceProvider),
      source: 'bridged' as const,
      sourceLabel: m.sourceLabel,
    }));
  return { models: [...builtin, ...bridged] };
}

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleSelectDirectory(
  getMainWindow: () => AppWindow | null,
  getAppService: () => AgentApplicationService | null,
  getConfigService: () => ConfigService | null,
): Promise<string | null> {
  const mainWindow = getMainWindow();
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Directory',
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selectedPath = result.filePaths[0];
  const appService = getAppService();
  if (appService) appService.setWorkingDirectory(selectedPath);

  // Selecting a directory through the picker counts as actually entering it —
  // record it in workspace.recentDirectories so the Settings page surfaces it.
  await getConfigService()?.addRecentDirectory(selectedPath);

  return selectedPath;
}

async function handleGetCurrent(getAppService: () => AgentApplicationService | null): Promise<string | null> {
  return getAppService()?.getWorkingDirectory() ?? null;
}

async function handleSetCurrent(
  payload: { dir: string | null | undefined },
  getAppService: () => AgentApplicationService | null,
  getMainWindow: () => AppWindow | null,
  getConfigService: () => ConfigService | null,
): Promise<string | null> {
  const nextDir = payload.dir?.trim();
  if (!nextDir) {
    return null;
  }

  const appService = getAppService();
  if (appService) {
    appService.setWorkingDirectory(nextDir);
  }

  // 持久化到 settings.workspace.recentDirectories：configService 内部去重 +
  // 上限 10 条。让 WorkspaceSettings 表格直接拿到刚切过的目录。
  await getConfigService()?.addRecentDirectory(nextDir);

  // 广播给所有 renderer 订阅者（appStore），让渲染进程 workingDirectory 跟上
  // main 侧的变更。不依赖调用方 dual-write response.data，避免直调 domainAPI
  // 时 renderer store 落空（LivePreviewFrame.resolveSourceLocation 会 fallback
  // 到 process.cwd() 丢掉 "selected" 条）。
  getMainWindow()?.webContents.send(IPC_CHANNELS.WORKSPACE_CURRENT_CHANGED, { dir: nextDir });

  return nextDir;
}

async function handleListRecent(
  getConfigService: () => ConfigService | null,
): Promise<string[]> {
  const settings = getConfigService()?.getSettings();
  return settings?.workspace?.recentDirectories ?? [];
}

async function handleRemoveRecent(
  payload: { dir: string | null | undefined },
  getConfigService: () => ConfigService | null,
): Promise<string[]> {
  const target = payload.dir?.trim();
  const configService = getConfigService();
  if (!target || !configService) {
    return configService?.getSettings().workspace?.recentDirectories ?? [];
  }

  const current = configService.getSettings().workspace?.recentDirectories ?? [];
  const next = current.filter((entry) => entry !== target);
  if (next.length === current.length) {
    return current;
  }

  await configService.updateSettings({
    workspace: {
      ...configService.getSettings().workspace,
      recentDirectories: next,
    },
  });
  return next;
}

async function handleListFiles(payload: { dirPath: string }): Promise<FileInfo[]> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  try {
    const entries = await fs.readdir(payload.dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      path: pathModule.join(payload.dirPath, entry.name),
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

async function handleReadFile(payload: { filePath: string }): Promise<string> {
  const fs = await import('fs/promises');
  return fs.readFile(payload.filePath, 'utf-8');
}

// Map extensions to IANA mime types for PreviewPanel image/pdf rendering.
// Only covers what PREVIEWABLE_EXTENSIONS advertises for media; anything
// else defaults to application/octet-stream.
const BINARY_MIME_BY_EXT: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  pdf:  'application/pdf',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  m4a:  'audio/mp4',
  aac:  'audio/aac',
  flac: 'audio/flac',
  ogg:  'audio/ogg',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  mkv:  'video/x-matroska',
  avi:  'video/x-msvideo',
};

async function handleReadBinary(
  payload: { filePath: string },
): Promise<{ base64: string; mimeType: string; size: number }> {
  const fs = await import('fs/promises');
  const buffer = await fs.readFile(payload.filePath);
  const dot = payload.filePath.lastIndexOf('.');
  const ext = dot >= 0 ? payload.filePath.slice(dot + 1).toLowerCase() : '';
  return {
    base64: buffer.toString('base64'),
    mimeType: BINARY_MIME_BY_EXT[ext] || 'application/octet-stream',
    size: buffer.byteLength,
  };
}

export async function handleWriteFile(
  payload: { filePath: string; content: string }
): Promise<{ path: string; size: number; modifiedAt: number }> {
  const fs = await import('fs/promises');
  await fs.writeFile(payload.filePath, payload.content, 'utf-8');
  const stat = await fs.stat(payload.filePath);
  return {
    path: payload.filePath,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  };
}

export async function handleCreateFile(
  payload: { filePath: string; content?: string }
): Promise<FileInfo> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // 'wx' flag: fail if path exists. Prevents accidental overwrite.
  await fs.writeFile(payload.filePath, payload.content ?? '', { flag: 'wx' });
  const stat = await fs.stat(payload.filePath);
  return {
    name: pathModule.basename(payload.filePath),
    path: payload.filePath,
    isDirectory: false,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  };
}

export async function handleCreateFolder(payload: { dirPath: string }): Promise<FileInfo> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // Non-recursive: fail if exists. User clicked "New Folder", a merge would surprise them.
  await fs.mkdir(payload.dirPath);
  const stat = await fs.stat(payload.dirPath);
  return {
    name: pathModule.basename(payload.dirPath),
    path: payload.dirPath,
    isDirectory: true,
    modifiedAt: stat.mtimeMs,
  };
}

async function handleOpenPath(
  payload: { filePath: string },
  getAppService: () => AgentApplicationService | null
): Promise<string> {
  const { shell } = await import('../platform');
  const pathModule = await import('path');

  let resolvedPath = payload.filePath;

  // If path is relative, resolve it against working directory
  if (!pathModule.isAbsolute(resolvedPath)) {
    const workingDir = getAppService()?.getWorkingDirectory();
    if (workingDir) {
      resolvedPath = pathModule.join(workingDir, resolvedPath);
    }
  }

  return shell.openPath(resolvedPath);
}

// 打开 http(s) 外链到系统默认浏览器。走 IPC 桥（host 进程），不依赖 webview 里的
// __TAURI_INTERNALS__ —— 修 bug A：webServer 提供的 http origin webview 里 Tauri 插件
// 直连不可用，导致聊天里的外链点击无反应。
async function handleOpenExternal(payload: { url: string }): Promise<string> {
  const { shell } = await import('../platform');
  if (!/^https?:\/\//i.test(payload.url)) {
    throw new Error('openExternal only accepts http(s) URLs');
  }
  await shell.openExternal(payload.url);
  return '';
}

async function handleShowItemInFolder(
  payload: { filePath: string },
  getAppService: () => AgentApplicationService | null
): Promise<void> {
  const { shell } = await import('../platform');
  const pathModule = await import('path');

  let resolvedPath = payload.filePath;

  // If path is relative, resolve it against working directory
  if (!pathModule.isAbsolute(resolvedPath)) {
    const workingDir = getAppService()?.getWorkingDirectory();
    if (workingDir) {
      resolvedPath = pathModule.join(workingDir, resolvedPath);
    }
  }

  shell.showItemInFolder(resolvedPath);
}

export async function handleDownloadFile(
  payload: { url: string; filename?: string }
): Promise<{ filePath: string }> {
  const { app } = await import('../platform');
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // SSRF 收口（审计修订2）：downloadFile 是 IPC 暴露的任意 URL 裸 fetch，必须挡私网/环回/
  // 元数据地址，杜绝被当跳板。放行 http/https 公网（下载比出图宽松）。
  assertSafeDownloadUrl(payload.url);

  // 下载到用户下载目录。文件名收窄到 basename（审计 MED-1）：payload.filename 可能含
  // '../../.code-agent/.env' 想逃出 downloads 目录覆盖任意文件，basename 去掉路径分量，
  // 再断言解析后仍在 downloadsDir 内（纵深防御，basename 后理论上恒成立，越界即拒）。
  const downloadsDir = app.getPath('downloads');
  const safeName = pathModule.basename(payload.filename || `download_${Date.now()}`);
  const filePath = pathModule.join(downloadsDir, safeName);
  const rel = pathModule.relative(downloadsDir, filePath);
  if (!safeName || rel.startsWith('..') || pathModule.isAbsolute(rel)) {
    throw new Error('拒绝：下载文件名越界（必须落在下载目录内）');
  }

  // 下载文件。SSRF-via-redirect 防护（审计 HIGH-1）：守卫只校验了初始 URL host；
  // redirect:manual 截停 3xx 跳转，杜绝端点把请求跳到内网/元数据地址绕过守卫。
  const response = await fetch(payload.url, { redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('拒绝下载：URL 发生跳转（SSRF 防护）');
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(filePath, Buffer.from(buffer));

  return { filePath };
}

interface WorkspaceBundleFileInput {
  path: string;
  name?: string;
  role?: string;
  mimeType?: string;
  sha256?: string;
}

interface WorkspaceExportBundlePayload {
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

async function handleGetDesignMdSummary(payload: { cwd?: string | null }): Promise<string | null> {
  const cwd = payload.cwd?.trim();
  if (!cwd) {
    return null;
  }
  return readDesignMdSummary(cwd);
}


// 视觉模型可用性：key 逻辑只在主进程；按 provider 复用现有 getter，绝不向 renderer 暴露 key 值。
function providerKeyConfigured(provider: string): boolean {
  if (provider === 'dashscope') return !!getDashscopeApiKey();
  if (provider === 'zhipu') return !!getZhipuOfficialApiKey();
  if (provider === 'openrouter') return !!getConfigService().getApiKey('openrouter');
  if (provider === 'gptimage') return !!getGptImageConfig();
  if (provider === 'minimax') return !!getMinimaxApiKey();
  return false;
}

// 列出注册表全部生图模型（内置 + 自定义），并按用户是否已配对应 key 标 available。
// 出参只含 id/label/provider/available——绝不回传 key 值/baseUrl（信任边界）。
export async function handleListVisualImageModels(
  getSettings: () => AppSettings | null = () => null,
  isProviderKeyConfigured: (provider: string) => boolean = () => false,
): Promise<{
  models: Array<{ id: string; label: string; provider: string; available: boolean; source: 'builtin' | 'custom' | 'bridged'; sourceLabel?: string }>;
}> {
  const builtin = IMAGE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider as string,
    available: providerKeyConfigured(m.provider),
    source: 'builtin' as const,
  }));
  // 自定义模型（借鉴项①）：available = 该模型是否已配 key（每模型独立 key）。
  const customs = await listCustomImageModels();
  const customList = customs.map((c) => ({
    id: c.id,
    label: c.label,
    provider: 'custom',
    available: !!getCustomModelApiKey(c.id),
    source: 'custom' as const,
  }));
  // 桥接模型：从已配置聊天 provider 派生带生图能力的模型（P1 多模态桥接）。
  // available = 源 provider 的 key 是否已配（沿用主进程信任边界，不回 key 值）。
  const bridged = deriveBridgedVisualModels(getSettings())
    .filter((m) => m.mediaType === 'image')
    .map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.sourceProvider,
      available: isProviderKeyConfigured(m.sourceProvider),
      source: 'bridged' as const,
      sourceLabel: m.sourceLabel,
    }));
  return { models: [...builtin, ...customList, ...bridged] };
}

// ----------------------------------------------------------------------------
// 自定义生图模型管理（借鉴项①）：薄 handler，CRUD 逻辑在 customImageModelRegistry。
// ----------------------------------------------------------------------------

// 列出自定义模型（含 baseUrl/modelName 供管理 UI 展示 + available 标 key 是否已配）。绝不回 key 值。
export async function handleListCustomImageModels(): Promise<{
  models: Array<{ id: string; label: string; baseUrl: string; modelName: string; costCnyPerImage?: number; available: boolean }>;
}> {
  const customs = await listCustomImageModels();
  return {
    models: customs.map((c) => ({
      id: c.id,
      label: c.label,
      baseUrl: c.baseUrl,
      modelName: c.modelName,
      ...(c.costCnyPerImage !== undefined ? { costCnyPerImage: c.costCnyPerImage } : {}),
      available: !!getCustomModelApiKey(c.id),
    })),
  };
}

// 新建自定义模型：注册表校验 label/modelName + SSRF 守卫 baseUrl → 落盘 → 存 key 进 SecureStorage。
// apiKey 必填（无 key 的模型不可用，存了只是污染列表）。返回最终 id。
export async function handleSaveCustomImageModel(payload: {
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerImage?: number;
  apiKey: string;
}): Promise<{ id: string }> {
  if (!payload?.apiKey?.trim()) {
    throw new Error('saveCustomImageModel 需要非空 API Key');
  }
  const { id } = await saveCustomImageModel({
    label: payload.label,
    baseUrl: payload.baseUrl,
    modelName: payload.modelName,
    costCnyPerImage: payload.costCnyPerImage,
  });
  setCustomModelApiKey(id, payload.apiKey.trim());
  return { id };
}

export async function handleDeleteCustomImageModel(payload: { id: string }): Promise<{ ok: true }> {
  if (!payload?.id) {
    throw new Error('deleteCustomImageModel 需要 id');
  }
  return deleteCustomImageModel(payload.id);
}

// ----------------------------------------------------------------------------
// 自定义生视频模型管理（视觉模型设置 tab · 配置层 only）：与 image 对称的薄 handler。
// ⚠️ 不接出片生成——视频无 OpenAI 兼容统一标准，出片协议待接入；故无 generateDesignVideo 路由
// 分支、不并入 VideoModelPicker。这里只做 list/save/delete 配置。绝不回 key 值。
// ----------------------------------------------------------------------------

export async function handleListCustomVideoModels(): Promise<{
  models: Array<{ id: string; label: string; baseUrl: string; modelName: string; costCnyPerVideo?: number; available: boolean }>;
}> {
  const customs = await listCustomVideoModels();
  return {
    models: customs.map((c) => ({
      id: c.id,
      label: c.label,
      baseUrl: c.baseUrl,
      modelName: c.modelName,
      ...(c.costCnyPerVideo !== undefined ? { costCnyPerVideo: c.costCnyPerVideo } : {}),
      available: !!getCustomVideoModelApiKey(c.id),
    })),
  };
}

export async function handleSaveCustomVideoModel(payload: {
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerVideo?: number;
  apiKey: string;
}): Promise<{ id: string }> {
  if (!payload?.apiKey?.trim()) {
    throw new Error('saveCustomVideoModel 需要非空 API Key');
  }
  const { id } = await saveCustomVideoModel({
    label: payload.label,
    baseUrl: payload.baseUrl,
    modelName: payload.modelName,
    costCnyPerVideo: payload.costCnyPerVideo,
  });
  setCustomVideoModelApiKey(id, payload.apiKey.trim());
  return { id };
}

export async function handleDeleteCustomVideoModel(payload: { id: string }): Promise<{ ok: true }> {
  if (!payload?.id) {
    throw new Error('deleteCustomVideoModel 需要 id');
  }
  return deleteCustomVideoModel(payload.id);
}

// ── 设计工作区轻量行为偏好（设置页配置，设计页只消费）──
export async function handleGetDesignSettings(): Promise<DesignSettings> {
  return readDesignSettings();
}

export async function handleUpdateDesignSettings(payload: Partial<DesignSettings>): Promise<DesignSettings> {
  // 只接受已知布尔字段，忽略未知键（防 renderer 误传污染落盘 json）。
  const patch: Partial<DesignSettings> = {};
  if (typeof payload?.regionLockStrict === 'boolean') patch.regionLockStrict = payload.regionLockStrict;
  return updateDesignSettings(patch);
}

// ----------------------------------------------------------------------------
// PDF 导出（CD-Parity §2）：HTML 原型走 playwright page.pdf()，栅格产物走 pdfkit 图嵌。
// 渲染/嵌图逻辑在独立模块 services/design/pdfExport.ts，这里只做编排 + 落盘。
// ----------------------------------------------------------------------------

// HTML 原型 → 矢量 PDF → 落「下载」。chromium 不可用时 htmlToPdf 抛可读错误，
// 经统一 catch 回传给 renderer（renderer 据此提示并回退导出 .html）。
async function handleExportPrototypePdf(
  payload: { html: string; outputName: string },
): Promise<{ filePath: string }> {
  if (!payload?.html || !payload?.outputName) {
    throw new Error('exportPrototypePdf 需要 html 与 outputName');
  }
  const pdf = await htmlToPdf(payload.html);
  return handleSaveBinaryToDownloads({
    fileName: payload.outputName,
    base64: pdf.toString('base64'),
  });
}

// 栅格产物 → 单页 PDF → 落「下载」。两种来源：imagePath（磁盘，须落设计目录内，
// 防路径越界读任意文件）或 dataUrl（renderer 直接传 base64）。
async function handleExportImagePdf(
  payload: { imagePath?: string; dataUrl?: string; outputName: string },
): Promise<{ filePath: string }> {
  if (!payload?.outputName || (!payload.imagePath && !payload.dataUrl)) {
    throw new Error('exportImagePdf 需要 outputName 与 imagePath 或 dataUrl 之一');
  }
  let imageBuffer: Buffer;
  if (payload.imagePath) {
    assertWithinDesignDir(payload.imagePath, 'imagePath');
    imageBuffer = await fsp.readFile(payload.imagePath);
  } else {
    const base64 = (payload.dataUrl ?? '').replace(/^data:[^;]+;base64,/, '');
    imageBuffer = Buffer.from(base64, 'base64');
  }
  const pdf = await imageToPdf(imageBuffer);
  return handleSaveBinaryToDownloads({
    fileName: payload.outputName,
    base64: pdf.toString('base64'),
  });
}

// ----------------------------------------------------------------------------
// 品牌契约 registry（CD-Parity §1）：薄 handler，读写逻辑在独立模块
// services/design/brandRegistry.ts，这里只做编排转发。
// ----------------------------------------------------------------------------

async function handleListBrands() {
  return registryListBrands();
}

async function handleSaveBrand(payload: { brand: Partial<BrandContract> }) {
  if (!payload?.brand) {
    throw new Error('saveBrand 需要 brand');
  }
  return registrySaveBrand(payload.brand);
}

async function handleDeleteBrand(payload: { id: string }) {
  if (!payload?.id) {
    throw new Error('deleteBrand 需要 id');
  }
  return registryDeleteBrand(payload.id);
}

async function handleSetActiveBrand(payload: { id: string | null }) {
  return registrySetActiveBrand(payload?.id ?? null);
}

// 从参考图提取品牌草稿（B2，vision，付费一次）。renderer 传 dataUrl（FileReader 读本地
// 文件，免落盘）；若传 imagePath 必须落在设计目录内（与其它图 handler 同款守卫，防读任意
// 本地文件 base64 后外泄到视觉模型）。返回 DRAFT，不落盘——由 renderer 预填表单待用户审改。
async function handleExtractBrandFromImage(payload: { dataUrl?: string; imagePath?: string }) {
  if (!payload?.dataUrl && !payload?.imagePath) {
    throw new Error('extractBrandFromImage 需要 dataUrl 或 imagePath');
  }
  if (payload.imagePath) {
    assertWithinDesignDir(payload.imagePath, 'imagePath');
  }
  const input = payload.dataUrl ? { dataUrl: payload.dataUrl } : { imagePath: payload.imagePath };
  return registryExtractBrand(input);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Workspace 相关 IPC handlers
 */
export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => AppWindow | null,
  getAppService: () => AgentApplicationService | null,
  getConfigService: () => ConfigService | null,
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.WORKSPACE, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'selectDirectory':
          data = await handleSelectDirectory(getMainWindow, getAppService, getConfigService);
          break;
        case 'getCurrent':
          data = await handleGetCurrent(getAppService);
          break;
        case 'setCurrent':
          data = await handleSetCurrent(payload as { dir: string | null | undefined }, getAppService, getMainWindow, getConfigService);
          break;
        case 'listRecent':
          data = await handleListRecent(getConfigService);
          break;
        case 'listVisualImageModels':
          data = await handleListVisualImageModels(
            () => getConfigService()?.getSettings() ?? null,
            (p) => { try { return !!getSecureStorage().getApiKey(p); } catch { return false; } },
          );
          break;
        case 'listCustomImageModels':
          data = await handleListCustomImageModels();
          break;
        case 'saveCustomImageModel':
          data = await handleSaveCustomImageModel(
            payload as { label: string; baseUrl: string; modelName: string; costCnyPerImage?: number; apiKey: string },
          );
          break;
        case 'deleteCustomImageModel':
          data = await handleDeleteCustomImageModel(payload as { id: string });
          break;
        case 'listCustomVideoModels':
          data = await handleListCustomVideoModels();
          break;
        case 'saveCustomVideoModel':
          data = await handleSaveCustomVideoModel(
            payload as { label: string; baseUrl: string; modelName: string; costCnyPerVideo?: number; apiKey: string },
          );
          break;
        case 'deleteCustomVideoModel':
          data = await handleDeleteCustomVideoModel(payload as { id: string });
          break;
        case 'getDesignSettings':
          data = await handleGetDesignSettings();
          break;
        case 'updateDesignSettings':
          data = await handleUpdateDesignSettings(payload as Partial<DesignSettings>);
          break;
        case 'removeRecent':
          data = await handleRemoveRecent(payload as { dir: string | null | undefined }, getConfigService);
          break;
        case 'listFiles':
          data = await handleListFiles(payload as { dirPath: string });
          break;
        case 'readFile':
          data = await handleReadFile(payload as { filePath: string });
          break;
        case 'readBinary':
          data = await handleReadBinary(payload as { filePath: string });
          break;
        case 'writeFile':
          data = await handleWriteFile(payload as { filePath: string; content: string });
          break;
        case 'saveTextToDownloads':
          data = await handleSaveTextToDownloads(payload as { fileName: string; content: string });
          break;
        case 'saveBinaryToDownloads':
          data = await handleSaveBinaryToDownloads(payload as { fileName: string; base64: string });
          break;
        case 'exportPrototypePdf':
          data = await handleExportPrototypePdf(payload as { html: string; outputName: string });
          break;
        case 'exportImagePdf':
          data = await handleExportImagePdf(
            payload as { imagePath?: string; dataUrl?: string; outputName: string },
          );
          break;
        case 'exportCanvasPptx':
          data = await handleExportCanvasPptx(
            payload as { images?: Array<{ imagePath?: string; dataUrl?: string }>; outputName: string },
          );
          break;
        case 'generateSlidesDeck':
          data = await handleGenerateSlidesDeck(payload as GenerateSlidesDeckPayload);
          break;
        case 'generateSlidesOutline':
          data = await handleGenerateSlidesOutline(payload as GenerateSlidesOutlinePayload);
          break;
        case 'generateSlidesPreview':
          data = await handleGenerateSlidesPreview(payload as GenerateSlidesPreviewPayload);
          break;
        case 'createFile':
          data = await handleCreateFile(payload as { filePath: string; content?: string });
          break;
        case 'createFolder':
          data = await handleCreateFolder(payload as { dirPath: string });
          break;
        case 'openPath':
          data = await handleOpenPath(payload as { filePath: string }, getAppService);
          break;
        case 'openExternal':
          data = await handleOpenExternal(payload as { url: string });
          break;
        case 'showItemInFolder':
          data = await handleShowItemInFolder(payload as { filePath: string }, getAppService);
          break;
        case 'downloadFile':
          data = await handleDownloadFile(payload as { url: string; filename?: string });
          break;
        case 'exportBundle':
          data = await handleExportBundle(payload as WorkspaceExportBundlePayload, getAppService);
          break;
        case 'inspectArchive':
          data = await handleInspectArchive(payload as { filePath: string; limit?: number });
          break;
        case 'inspectPresentation':
          data = await handleInspectPresentation(payload as { filePath: string; limit?: number });
          break;
        case 'getDesignMdSummary':
          data = await handleGetDesignMdSummary(payload as { cwd?: string | null });
          break;
        case 'getConfigScope':
          data = await handleGetConfigScope(payload as { workingDirectory?: string | null } | undefined, getAppService);
          break;
        case 'resolveDesignDir':
          data = await handleResolveDesignDir();
          break;
        case 'generateDesignImage':
          data = await handleGenerateDesignImage(
            payload as { prompt: string; aspectRatio?: string; outputPath: string; model?: string },
            () => getConfigService()?.getSettings() ?? null,
          );
          break;
        case 'editDesignImage':
          data = await handleEditDesignImage(
            payload as { prompt: string; baseImagePath: string; maskDataUrl: string; outputPath: string },
          );
          break;
        case 'editImageByAnnotation':
          data = await handleEditImageByAnnotation(
            payload as { model: string; annotatedImageDataUrl: string; instruction: string; outputPath: string },
          );
          break;
        case 'importDesignImage':
          data = await handleImportDesignImage(payload as { dataUrl: string; outputPath: string });
          break;
        case 'expandDesignImage':
          data = await handleExpandDesignImage(
            payload as { baseImagePath: string; outputPath: string; direction: ExpandDirection; ratio: number; prompt?: string },
          );
          break;
        case 'removeWatermarkDesignImage':
          data = await handleRemoveWatermarkDesignImage(
            payload as { baseImagePath: string; outputPath: string; prompt?: string },
          );
          break;
        case 'generateDesignVideo':
          data = await handleGenerateDesignVideo(
            payload as { mode: 't2v' | 'i2v'; prompt?: string; baseImagePath?: string; outputPath: string; model: string; durationSec?: number },
            () => getConfigService()?.getSettings() ?? null,
          );
          break;
        case 'listVisualVideoModels':
          data = await handleListVisualVideoModels(
            () => getConfigService()?.getSettings() ?? null,
            (p) => { try { return !!getSecureStorage().getApiKey(p); } catch { return false; } },
          );
          break;
        case 'listVisualMusicModels':
          data = await handleListVisualMusicModels(
            () => getConfigService()?.getSettings() ?? null,
            (p) => { try { return !!getSecureStorage().getApiKey(p); } catch { return false; } },
          );
          break;
        case 'listBrands':
          data = await handleListBrands();
          break;
        case 'saveBrand':
          data = await handleSaveBrand(payload as { brand: Partial<BrandContract> });
          break;
        case 'deleteBrand':
          data = await handleDeleteBrand(payload as { id: string });
          break;
        case 'setActiveBrand':
          data = await handleSetActiveBrand(payload as { id: string | null });
          break;
        case 'extractBrandFromImage':
          data = await handleExtractBrandFromImage(payload as { dataUrl?: string; imagePath?: string });
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

}
