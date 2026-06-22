// 设计工作区的工作区文件读取工具（renderer 侧，经 WORKSPACE domain IPC）。
// hook 轮询与历史加载共用，避免重复。
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_VERSIONS_SUBDIR } from '@shared/constants';
import type { FileInfo } from '@shared/contract/workspace';
import type { SlideOutlineItem } from './slidesOutlineOps';
import type { BrandContract, BrandMeta } from '@shared/contract/brandContract';
import { normalizeBrandContract } from '@shared/contract/brandContract';
import { versionFileName, parseVersionTs } from './designTypes';

/** 一次原型版本快照。 */
export type DesignVersion = {
  /** 快照文件绝对路径（唯一 id）。 */
  path: string;
  /** 创建时间戳（从文件名解析）。 */
  createdAt: number;
};

export async function readWorkspaceFile(filePath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<string>(IPC_DOMAINS.WORKSPACE, 'readFile', {
      filePath,
    });
    return res?.success ? ((res.data as string) ?? '') : null;
  } catch {
    return null;
  }
}

/** 列 run 目录里的 html 文件路径（优先 prototype.html，否则任一 .html）；无则返回 null。 */
export async function findRunHtml(dirPath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<FileInfo[]>(IPC_DOMAINS.WORKSPACE, 'listFiles', {
      dirPath,
    });
    if (!res?.success || !Array.isArray(res.data)) return null;
    const htmls = res.data.filter((f) => !f.isDirectory && /\.html?$/i.test(f.name));
    if (htmls.length === 0) return null;
    const preferred = htmls.find((f) => /^prototype\./i.test(f.name));
    return (preferred ?? htmls[0]).path;
  } catch {
    return null;
  }
}

/** 读取某 run 目录里最新 html 的内容（用于历史加载/刷新恢复）。 */
export async function readRunHtml(runDir: string): Promise<string | null> {
  const htmlPath = await findRunHtml(runDir);
  return htmlPath ? readWorkspaceFile(htmlPath) : null;
}

/** 解析 app 托管的设计草稿根目录（主进程返回绝对路径，已确保存在）。 */
export async function resolveDesignDir(): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<{ dir: string }>(
      IPC_DOMAINS.WORKSPACE,
      'resolveDesignDir',
      {},
    );
    return res?.success ? (res.data?.dir ?? null) : null;
  } catch {
    return null;
  }
}

/** 写入工作区文件（覆盖）。成功返回 true。 */
export async function writeWorkspaceFile(filePath: string, content: string): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'writeFile', {
      filePath,
      content,
    });
    return res?.success === true;
  } catch {
    return false;
  }
}

/** 把当前原型 html 快照成一份版本文件（versions/v-<ts>.html）。失败静默。 */
export async function snapshotVersion(runDir: string, html: string, ts: number): Promise<void> {
  const versionsDir = `${runDir.replace(/\/+$/, '')}/${DESIGN_VERSIONS_SUBDIR}`;
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath: versionsDir });
  } catch {
    // 已存在则忽略（createFolder 非递归、存在即抛）。
  }
  await writeWorkspaceFile(`${versionsDir}/${versionFileName(ts)}`, html);
}

/** 在系统默认应用打开文件（.html → 默认浏览器）。成功返回 true。 */
export async function openInDefaultApp(filePath: string): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'openPath', { filePath });
    return res?.success === true;
  } catch {
    return false;
  }
}

/** 把 HTML 文本导出到「下载」目录（重名自动加后缀）。返回落盘路径或 null。 */
export async function saveHtmlToDownloads(
  fileName: string,
  content: string,
): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<{ filePath: string }>(
      IPC_DOMAINS.WORKSPACE,
      'saveTextToDownloads',
      { fileName, content },
    );
    return res?.success ? (res.data?.filePath ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * 原型 HTML → 矢量 PDF 导出到「下载」（主进程 playwright page.pdf）。
 * 返回落盘路径；chromium 不可用或失败时返回 { filePath: null, error }，由调用方提示降级。
 */
export async function exportPrototypePdf(
  html: string,
  outputName: string,
): Promise<{ filePath: string | null; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ filePath: string }>(
      IPC_DOMAINS.WORKSPACE,
      'exportPrototypePdf',
      { html, outputName },
    );
    if (res?.success) return { filePath: res.data?.filePath ?? null };
    return { filePath: null, error: res?.error?.message };
  } catch (e) {
    return { filePath: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 栅格产物（dataUrl 或设计目录内 imagePath）→ 单页 PDF 导出到「下载」（主进程 pdfkit 图嵌）。
 * 返回落盘路径；失败返回 { filePath: null, error }。
 */
export async function exportImagePdf(
  source: { dataUrl?: string; imagePath?: string },
  outputName: string,
): Promise<{ filePath: string | null; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ filePath: string }>(
      IPC_DOMAINS.WORKSPACE,
      'exportImagePdf',
      { ...source, outputName },
    );
    if (res?.success) return { filePath: res.data?.filePath ?? null };
    return { filePath: null, error: res?.error?.message };
  } catch (e) {
    return { filePath: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 画布产物（多张，dataUrl 或设计目录内 imagePath）→ 全幅 PPTX 导出到「下载」
 * （主进程 pptxgenjs，每图 1 张全幅 slide）。返回落盘路径；失败返回 { filePath: null, error }。
 */
export async function exportCanvasPptx(
  images: Array<{ dataUrl?: string; imagePath?: string }>,
  outputName: string,
): Promise<{ filePath: string | null; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ filePath: string }>(
      IPC_DOMAINS.WORKSPACE,
      'exportCanvasPptx',
      { images, outputName },
    );
    if (res?.success) return { filePath: res.data?.filePath ?? null };
    return { filePath: null, error: res?.error?.message };
  } catch (e) {
    return { filePath: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 厚版演示稿（二期）大纲生成：topic + 页数 → 确定性 SlideData[]（不落盘、不付费）。
 * 失败返回 { slides: null, error }。
 */
export async function generateSlidesOutline(input: {
  topic: string;
  slidesCount?: number;
  ai?: boolean;
}): Promise<{ slides: SlideOutlineItem[] | null; aiUsed?: boolean; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ slides: SlideOutlineItem[]; aiUsed: boolean }>(
      IPC_DOMAINS.WORKSPACE,
      'generateSlidesOutline',
      input,
    );
    if (res?.success) return { slides: res.data?.slides ?? null, aiUsed: res.data?.aiUsed };
    return { slides: null, error: res?.error?.message };
  } catch (e) {
    return { slides: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 厚版演示稿（二期）：topic/已编辑大纲 + 页数 → 主进程 slidesGenerator 真排版 deck → 导出到「下载」。
 * 返回落盘路径与页数；失败返回 { filePath: null, error }。
 */
export async function generateSlidesDeck(input: {
  topic?: string;
  slidesCount?: number;
  theme?: string;
  content?: string;
  slides?: SlideOutlineItem[];
  outputName: string;
}): Promise<{ filePath: string | null; slidesCount?: number; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ filePath: string; slidesCount: number }>(
      IPC_DOMAINS.WORKSPACE,
      'generateSlidesDeck',
      input,
    );
    if (res?.success) return { filePath: res.data?.filePath ?? null, slidesCount: res.data?.slidesCount };
    return { filePath: null, error: res?.error?.message };
  } catch (e) {
    return { filePath: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读取一张图片为 base64 dataURL；不存在/失败返回 null（画布按相对路径懒加载图片用）。 */
export async function readWorkspaceImageAsDataUrl(filePath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<{ base64: string; mimeType: string }>(
      IPC_DOMAINS.WORKSPACE,
      'readBinary',
      { filePath },
    );
    if (!res?.success || !res.data?.base64) return null;
    const mime = res.data.mimeType || 'image/png';
    return `data:${mime};base64,${res.data.base64}`;
  } catch {
    return null;
  }
}

/** 列某 run 的版本快照，按创建时间倒序（最新在前）。 */
export async function listVersions(runDir: string): Promise<DesignVersion[]> {
  const versionsDir = `${runDir.replace(/\/+$/, '')}/${DESIGN_VERSIONS_SUBDIR}`;
  try {
    const res = await window.domainAPI?.invoke<FileInfo[]>(IPC_DOMAINS.WORKSPACE, 'listFiles', {
      dirPath: versionsDir,
    });
    if (!res?.success || !Array.isArray(res.data)) return [];
    return res.data
      .map((f) => ({ path: f.path, createdAt: parseVersionTs(f.name) }))
      .filter((v): v is DesignVersion => v.createdAt != null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// 品牌契约 registry（CD-Parity §1）：renderer → main WORKSPACE IPC 薄封装。
// 后端读写在 src/main/services/design/brandRegistry.ts，4 个 action 已登记
// shellCapabilities。失败一律静默返回安全默认（null / false / 空列表）。
// ----------------------------------------------------------------------------

/** 列出所有品牌元数据 + 当前 active id；失败返回空表。 */
export async function listBrands(): Promise<{ brands: BrandMeta[]; activeId?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ brands: BrandMeta[]; activeId?: string }>(
      IPC_DOMAINS.WORKSPACE,
      'listBrands',
      {},
    );
    if (res?.success && res.data && Array.isArray(res.data.brands)) {
      return { brands: res.data.brands, activeId: res.data.activeId };
    }
    return { brands: [] };
  } catch {
    return { brands: [] };
  }
}

/**
 * 读单个品牌完整契约（编辑表单回填用）。后端无单独 getBrand IPC，但 brand.json 落在
 * <designDir>/brands/<id>/brand.json（设计目录内），复用 readFile 读取 + normalize。
 * 不存在/损坏返回 null。
 */
export async function readBrand(id: string): Promise<BrandContract | null> {
  if (!id) return null;
  const dir = await resolveDesignDir();
  if (!dir) return null;
  const jsonPath = `${dir.replace(/\/+$/, '')}/brands/${id}/brand.json`;
  const raw = await readWorkspaceFile(jsonPath);
  if (!raw) return null;
  try {
    return normalizeBrandContract(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

/** 写入/更新一份品牌契约；返回最终 id（新建时由后端派生），失败返回 null。 */
export async function saveBrand(brand: BrandContract): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<{ id: string }>(
      IPC_DOMAINS.WORKSPACE,
      'saveBrand',
      { brand },
    );
    return res?.success ? (res.data?.id ?? null) : null;
  } catch {
    return null;
  }
}

/** 删除一份品牌契约；成功返回 true。 */
export async function deleteBrand(id: string): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'deleteBrand', { id });
    return res?.success === true;
  } catch {
    return false;
  }
}

/** 设置/清空 active 品牌（传 null 清空）；成功返回 true。 */
export async function setActiveBrand(id: string | null): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'setActiveBrand', { id });
    return res?.success === true;
  } catch {
    return false;
  }
}

/** B2 抽取产物：DRAFT（best-effort tokens + 三桶），由调用方预填手填表单待用户审改。 */
export interface BrandDraft {
  tokens: BrandContract['tokens'];
  keep: string[];
  change: string[];
  doNotCopy: string[];
}

/**
 * 从参考图一次性提取品牌草稿（vision，付费一次）。传 dataUrl（renderer FileReader 读本地
 * 文件，免落盘）。后端不落盘、不自动保存——返回 DRAFT 供预填表单，用户审改命名后再 saveBrand。
 * 失败返回 { draft: null, error }，由调用方提示。
 */
export async function extractBrandFromImage(
  dataUrl: string,
): Promise<{ draft: BrandDraft | null; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<BrandDraft>(
      IPC_DOMAINS.WORKSPACE,
      'extractBrandFromImage',
      { dataUrl },
    );
    if (res?.success && res.data) return { draft: res.data };
    return { draft: null, error: res?.error?.message };
  } catch (e) {
    return { draft: null, error: e instanceof Error ? e.message : String(e) };
  }
}
