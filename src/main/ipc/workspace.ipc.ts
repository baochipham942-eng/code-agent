// ============================================================================
// Workspace IPC Handlers - workspace:* 通道
// ============================================================================

import type { IpcMain, BrowserWindow } from '../platform';
import path from 'path';
import { app, dialog } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { IPC_CHANNELS } from '../../shared/ipc/legacy-channels';
import { handleSaveTextToDownloads } from './workspaceSaveExport';
import { handleGetConfigScope } from './workspaceConfigScope';
// buildConfigScopeSummary 历史上是 workspace.ipc 的公开导出，保持向后兼容（测试依赖）。
export { buildConfigScopeSummary } from './workspaceConfigScope';
import type { FileInfo } from '../../shared/contract';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { ConfigService } from '../services';
import { readDesignMdSummary } from '../../design/design-md-loader';
import { estimateImageCostCny } from '../../shared/media/imageCost';
import { DESIGN_IMAGE_MODELS } from '../../shared/constants';
import { imageEngineForModel, defaultImageModelId } from '../../shared/constants/visualModels';
import { DESIGN_FLUX_MODEL } from '../../shared/constants/pricing';
import type { ExpandDirection } from '../services/media/imageGenerationService';
import { promises as fsp } from 'fs';
import { getUserConfigDir } from '../config/configPaths';
import { REGION_LOCK } from '../../shared/constants/designWorkspace';
import { runRegionLockGate } from '../services/media/imageConsistency';
import { loadSharp } from '../runtime/sharpRuntime';
import type { RegionLockReport } from '../../shared/contract/imageConsistency';

// 解析设计草稿目录（Kun 借鉴：设计 tab 自动落盘，免去手动选工作目录）。
// 设计产物是预览导向的草稿，统一放 app 托管目录 <home>/.code-agent/design，
// 用户无需选目录；需收进项目时再走显式「保存到项目」（后续）。
async function handleResolveDesignDir(): Promise<{ dir: string }> {
  const dir = path.join(getUserConfigDir(), 'design');
  await fsp.mkdir(dir, { recursive: true });
  return { dir };
}

// 设计图 handler 路径越界守卫（audit M1）：renderer 传入的 baseImagePath/outputPath 必须落在设计目录
// <getUserConfigDir>/design 内。挡住读任意本地文件(base64 后外泄到 DashScope)/写覆盖任意文件。
function assertWithinDesignDir(p: string, label: string): void {
  const root = path.resolve(getUserConfigDir(), 'design');
  const resolved = path.resolve(p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} 路径越界：必须位于设计目录内`);
  }
}

// 设计画布直连出图（Cowart 式 P1）：按 model 在视觉模型注册表间路由 engine（默认 wanx），
// renderer 不经 agent 直接出图——纯文生图无需 agent 推理，直连更确定。
// 生成 → 下载 OSS URL 转 base64 → 写盘到 outputPath → 返回路径，由 renderer 回灌画布。
export async function handleGenerateDesignImage(
  payload: { prompt: string; aspectRatio?: string; outputPath: string; model?: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.prompt || !payload?.outputPath) {
    throw new Error('generateDesignImage 需要 prompt 与 outputPath');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  // 按 model 路由到对应 engine（注册表守门，未知 id 抛错）；缺省回退默认 wanx。
  const engine = imageEngineForModel(payload.model || defaultImageModelId());
  // flux engine 需要具体模型串作 generateImage 的 fluxModel 入参；其余 engine 忽略此参。
  const fluxModelArg = engine === 'flux' ? DESIGN_FLUX_MODEL : '';
  const { generateImage, downloadImageAsBase64, isImageUrl } = await import(
    '../services/media/imageGenerationService'
  );
  const { imageData, actualModel } = await generateImage(engine, fluxModelArg, payload.prompt, payload.aspectRatio || '1:1');
  const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, buf);
  // 实际花费权威源在 main：按真正落地的模型查价表（T2 BYOK 成本可见）。
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}

// 设计画布导入用户自有图片（自由画布）：renderer 传 base64 dataURL → 写盘到 run 的 assets，
// 之后它就是普通画布节点，可被选中/圈选局部重绘（与生成图同构）。
async function handleImportDesignImage(
  payload: { dataUrl: string; outputPath: string },
): Promise<{ path: string }> {
  if (!payload?.dataUrl || !payload?.outputPath) {
    throw new Error('importDesignImage 需要 dataUrl 与 outputPath');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  const base64 = payload.dataUrl.replace(/^data:[^;]+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  return { path: payload.outputPath };
}

// 设计画布圈选局部重绘（Cowart 式 P2）：底图(磁盘路径)读成 base64 + renderer 传来的 mask
// (白=改/黑=留) → 通义万相 wanx2.1-imageedit 真 inpaint → 下载结果。
//
// T4 一致性锁定：模型输出落盘前先过 region-lock 闸——diff-gate 校验未选区域（mask 黑）逐
// 像素是否在 ε 内不变；越界则把原图未选区贴回（保证"其余不变"）并同目录落 diff 证据图。
// 返回 consistency 报告供 renderer 挂到画布节点（随 canvas.json 落 T1 spine）+ UI 徽章。
async function handleEditDesignImage(
  payload: { prompt: string; baseImagePath: string; maskDataUrl: string; outputPath: string },
): Promise<{ path: string; actualModel: string; costCny: number; consistency?: RegionLockReport }> {
  if (!payload?.prompt || !payload?.baseImagePath || !payload?.maskDataUrl || !payload?.outputPath) {
    throw new Error('editDesignImage 需要 prompt / baseImagePath / maskDataUrl / outputPath');
  }
  assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  const { editImageWithMask, downloadImageAsBase64, isImageUrl, getDashscopeApiKey } = await import(
    '../services/media/imageGenerationService'
  );
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('局部重绘需要百炼（DashScope）API Key。');
  const baseBuf = await fsp.readFile(payload.baseImagePath);
  const baseDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  const { url } = await editImageWithMask({
    apiKey,
    prompt: payload.prompt,
    baseImageDataUrl: baseDataUrl,
    maskImageDataUrl: payload.maskDataUrl,
  });
  const resultDataUrl = isImageUrl(url) ? await downloadImageAsBase64(url) : url;
  // data URI 前缀用宽松匹配（与 handleImportDesignImage 一致），兼容任意 image MIME 子类型。
  const resultBuf = Buffer.from(resultDataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });

  // mask dataURL → buffer（renderer 已按 白=改/黑=留 栅格化）。
  const maskBuf = Buffer.from(payload.maskDataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  // 局部重绘固定走 wanx imageedit；实际花费按该模型查价表（T2 BYOK 成本可见）。
  const actualModel = DESIGN_IMAGE_MODELS.edit;
  const costCny = estimateImageCostCny(actualModel);

  // 一致性闸。sharp 不可用或解码失败时降级为原模型输出（不阻断用户编辑），
  // 不返回 consistency（renderer 退回 legacy 无徽章行为）。
  const sharpLoaded = loadSharp();
  if (sharpLoaded.ok && sharpLoaded.sharp) {
    try {
      const gate = await runRegionLockGate({
        originalBuf: baseBuf,
        editedBuf: resultBuf,
        maskBuf,
        epsilon: REGION_LOCK.EPSILON,
        sharp: sharpLoaded.sharp,
      });
      await fsp.writeFile(payload.outputPath, gate.finalPng);
      const consistency: RegionLockReport = { ...gate.report };
      if (gate.diffPng) {
        const diffPath = `${payload.outputPath}${REGION_LOCK.DIFF_SUFFIX}`;
        await fsp.writeFile(diffPath, gate.diffPng);
        consistency.diffPath = diffPath;
      }
      return { path: payload.outputPath, actualModel, costCny, consistency };
    } catch (err) {
      // 闸内部异常：保底写模型原始输出，不阻断编辑；但留可观测日志，
      // 否则一致性逻辑静默失效（consistency 总是 undefined）无从排查。
      console.warn('[editDesignImage] region-lock gate failed, falling back to raw output:', err);
    }
  }
  await fsp.writeFile(payload.outputPath, resultBuf);
  return { path: payload.outputPath, actualModel, costCny };
}

// 设计画布扩图（T3：wanx function=expand）：底图(磁盘)读成 base64 + 方向/比例 → 四向单边 scale
// → 通义万相外扩补绘 → 下载结果写盘 → 返回路径，由 renderer 回灌为新 variant（挂 T1 spine）。
export async function handleExpandDesignImage(
  payload: { baseImagePath: string; outputPath: string; direction: ExpandDirection; ratio: number; prompt?: string },
): Promise<{ path: string }> {
  if (!payload?.baseImagePath || !payload?.outputPath) {
    throw new Error('expandDesignImage 需要 baseImagePath / outputPath');
  }
  assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  // 校验 direction 在合法集合内：非法值会让 expandScalesForDirection 落 default(四向 1.0)，
  // 即一次"扩了个寂寞"的付费空调用。在边界先拦掉（codex-audit M2）。
  const VALID_EXPAND_DIRECTIONS: readonly ExpandDirection[] = ['up', 'down', 'left', 'right', 'all'];
  if (!VALID_EXPAND_DIRECTIONS.includes(payload.direction)) {
    throw new Error(`expandDesignImage: 非法 direction「${String(payload.direction)}」，须为 up/down/left/right/all`);
  }
  // ratio 须为有限数且在 [1,2]（NaN/越界否则被 service 静默 clamp 成空操作付费调用）。
  if (!Number.isFinite(payload.ratio) || payload.ratio < 1 || payload.ratio > 2) {
    throw new Error('expandDesignImage: ratio 须为 [1,2] 区间内的有限数值');
  }
  const { expandImage, expandScalesForDirection, downloadImageAsBase64, isImageUrl, getDashscopeApiKey } = await import(
    '../services/media/imageGenerationService'
  );
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('扩图需要百炼（DashScope）API Key。');
  const baseBuf = await fsp.readFile(payload.baseImagePath);
  const baseDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  const scales = expandScalesForDirection(payload.direction, payload.ratio);
  const { url } = await expandImage({
    apiKey,
    prompt: payload.prompt?.trim() ? payload.prompt : '自然延伸画面背景，与原图风格一致',
    baseImageDataUrl: baseDataUrl,
    topScale: scales.top,
    bottomScale: scales.bottom,
    leftScale: scales.left,
    rightScale: scales.right,
  });
  const resultDataUrl = isImageUrl(url) ? await downloadImageAsBase64(url) : url;
  const base64 = resultDataUrl.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  return { path: payload.outputPath };
}

// 设计画布去水印（T3：wanx function=remove_watermark）：底图(磁盘)读成 base64 → 消除中英文文字水印
// → 下载结果写盘 → 返回路径，由 renderer 回灌为新 variant（挂 T1 spine）。
export async function handleRemoveWatermarkDesignImage(
  payload: { baseImagePath: string; outputPath: string; prompt?: string },
): Promise<{ path: string }> {
  if (!payload?.baseImagePath || !payload?.outputPath) {
    throw new Error('removeWatermarkDesignImage 需要 baseImagePath / outputPath');
  }
  assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  const { removeWatermark, downloadImageAsBase64, isImageUrl, getDashscopeApiKey } = await import(
    '../services/media/imageGenerationService'
  );
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('去水印需要百炼（DashScope）API Key。');
  const baseBuf = await fsp.readFile(payload.baseImagePath);
  const baseDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  const { url } = await removeWatermark({
    apiKey,
    baseImageDataUrl: baseDataUrl,
    prompt: payload.prompt,
  });
  const resultDataUrl = isImageUrl(url) ? await downloadImageAsBase64(url) : url;
  const base64 = resultDataUrl.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  return { path: payload.outputPath };
}

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleSelectDirectory(
  getMainWindow: () => BrowserWindow | null,
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
  getMainWindow: () => BrowserWindow | null,
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

async function handleDownloadFile(
  payload: { url: string; filename?: string }
): Promise<{ filePath: string }> {
  const { app } = await import('../platform');
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // 下载到用户下载目录
  const downloadsDir = app.getPath('downloads');
  const filename = payload.filename || `download_${Date.now()}`;
  const filePath = pathModule.join(downloadsDir, filename);

  // 下载文件
  const response = await fetch(payload.url);
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


// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Workspace 相关 IPC handlers
 */
export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
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
        case 'createFile':
          data = await handleCreateFile(payload as { filePath: string; content?: string });
          break;
        case 'createFolder':
          data = await handleCreateFolder(payload as { dirPath: string });
          break;
        case 'openPath':
          data = await handleOpenPath(payload as { filePath: string }, getAppService);
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
          );
          break;
        case 'editDesignImage':
          data = await handleEditDesignImage(
            payload as { prompt: string; baseImagePath: string; maskDataUrl: string; outputPath: string },
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
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

}
