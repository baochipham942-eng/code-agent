// 设计工作区的工作区文件读取工具（renderer 侧，经 WORKSPACE domain IPC）。
// hook 轮询与历史加载共用，避免重复。
import { IPC_DOMAINS } from '@shared/ipc';
import { REGION_LOCK } from '@shared/constants';
import type { BrandContract, BrandMeta } from '@shared/contract/brandContract';
import { normalizeBrandContract } from '@shared/contract/brandContract';

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

/**
 * 读工作区二进制为 Blob URL（非 data URL）。
 * 视频走此路径——4MB mp4 的 data: URL 超浏览器 ~2MB 上限会 0:00 放不动；
 * Blob URL 无大小限制。调用方负责在不用时 URL.revokeObjectURL 回收。
 */
export async function readWorkspaceBinaryAsBlobUrl(filePath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<{ base64: string; mimeType: string }>(
      IPC_DOMAINS.WORKSPACE,
      'readBinary',
      { filePath },
    );
    if (!res?.success || !res.data?.base64) return null;
    const mime = res.data.mimeType || 'application/octet-stream';
    const binary = atob(res.data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// 品牌契约 registry（CD-Parity §1）：renderer → main WORKSPACE IPC 薄封装。
// 后端读写在 src/host/services/design/brandRegistry.ts，4 个 action 已登记
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

// ── 自定义生图模型（借鉴项①）IPC 封装 ──

export interface CustomImageModelMeta {
  id: string;
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerImage?: number;
  available: boolean;
}

/** 列出已添加的自定义生图模型（含 available，标 key 是否已配）；失败返回空表。 */
export async function listCustomImageModels(): Promise<CustomImageModelMeta[]> {
  try {
    const res = await window.domainAPI?.invoke<{ models: CustomImageModelMeta[] }>(
      IPC_DOMAINS.WORKSPACE,
      'listCustomImageModels',
      {},
    );
    if (res?.success && Array.isArray(res.data?.models)) return res.data.models;
    return [];
  } catch {
    return [];
  }
}

/** 新建自定义生图模型；返回 {id} 或 {error}。apiKey 必填。 */
export async function saveCustomImageModel(input: {
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerImage?: number;
  apiKey: string;
}): Promise<{ id: string | null; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ id: string }>(
      IPC_DOMAINS.WORKSPACE,
      'saveCustomImageModel',
      input,
    );
    if (res?.success && res.data?.id) return { id: res.data.id };
    return { id: null, error: res?.error?.message };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 删除一个自定义生图模型（连带清除密钥）；成功返回 true。 */
export async function deleteCustomImageModel(id: string): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'deleteCustomImageModel', { id });
    return res?.success === true;
  } catch {
    return false;
  }
}

// ── 自定义生视频模型 IPC 封装（视觉模型设置 tab · 配置层 only，不接出片） ──

export interface CustomVideoModelMeta {
  id: string;
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerVideo?: number;
  available: boolean;
}

/** 列出已添加的自定义生视频模型（含 available）；失败返回空表。 */
export async function listCustomVideoModels(): Promise<CustomVideoModelMeta[]> {
  try {
    const res = await window.domainAPI?.invoke<{ models: CustomVideoModelMeta[] }>(
      IPC_DOMAINS.WORKSPACE,
      'listCustomVideoModels',
      {},
    );
    if (res?.success && Array.isArray(res.data?.models)) return res.data.models;
    return [];
  } catch {
    return [];
  }
}

/** 新建自定义生视频模型；返回 {id} 或 {error}。apiKey 必填。 */
export async function saveCustomVideoModel(input: {
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerVideo?: number;
  apiKey: string;
}): Promise<{ id: string | null; error?: string }> {
  try {
    const res = await window.domainAPI?.invoke<{ id: string }>(
      IPC_DOMAINS.WORKSPACE,
      'saveCustomVideoModel',
      input,
    );
    if (res?.success && res.data?.id) return { id: res.data.id };
    return { id: null, error: res?.error?.message };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 删除一个自定义生视频模型（连带清除密钥）；成功返回 true。 */
export async function deleteCustomVideoModel(id: string): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'deleteCustomVideoModel', { id });
    return res?.success === true;
  } catch {
    return false;
  }
}

// ── 设计工作区轻量行为偏好（设置页配置层）──
/** 设计工作区行为偏好（与 main designSettings.ts 结构对齐，IPC 边界按结构匹配）。 */
export interface DesignWorkspaceSettings {
  /** 局部重绘一致性严格模式：region-lock 无法强制执行时拒绝产出未保证图（默认 false）。 */
  regionLockStrict: boolean;
}

const DESIGN_SETTINGS_DEFAULT: DesignWorkspaceSettings = { regionLockStrict: REGION_LOCK.STRICT_DEFAULT };

export async function getDesignSettings(): Promise<DesignWorkspaceSettings> {
  try {
    const res = await window.domainAPI?.invoke<DesignWorkspaceSettings>(
      IPC_DOMAINS.WORKSPACE,
      'getDesignSettings',
      {},
    );
    if (res?.success && res.data && typeof res.data.regionLockStrict === 'boolean') {
      return { regionLockStrict: res.data.regionLockStrict };
    }
    return DESIGN_SETTINGS_DEFAULT;
  } catch {
    return DESIGN_SETTINGS_DEFAULT;
  }
}

/** 写入设计偏好，返回合并后的完整偏好；失败回退入参的乐观值。 */
export async function updateDesignSettings(
  patch: Partial<DesignWorkspaceSettings>,
): Promise<DesignWorkspaceSettings> {
  try {
    const res = await window.domainAPI?.invoke<DesignWorkspaceSettings>(
      IPC_DOMAINS.WORKSPACE,
      'updateDesignSettings',
      patch,
    );
    if (res?.success && res.data && typeof res.data.regionLockStrict === 'boolean') {
      return { regionLockStrict: res.data.regionLockStrict };
    }
  } catch {
    /* 落到下方回退 */
  }
  return { ...DESIGN_SETTINGS_DEFAULT, ...patch };
}
