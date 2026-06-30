// ============================================================================
// 自定义生视频模型注册表（视觉模型设置 tab · 配置层）—— 与 customImageModelRegistry 对称
// ----------------------------------------------------------------------------
// 内置 VIDEO_MODELS 静态表（visualModels.ts）永不改，用户自填的视频生成端点存这里：
// metadata 落盘 JSON，API key 单独进 SecureStorage（不进明文 json）。
//
//   <getUserConfigDir>/design/custom-video-models.json   { models: CustomVideoModel[] }
//   SecureStorage  apikey.custom-video:<id>              用户填的 key
//
// 出片已接通（Spec 1）：custom 视频经 handleGenerateDesignVideo 的 custom 分支走通用
// generateVideoOpenAICompat（POST /videos + flavor 轮询），与 image 的 openai-compat 路径对称。
// 本文件仍只负责「填表/落盘/管理」(list/save/delete + key)，执行编排在 ipc handler 侧。
// ============================================================================

import { promises as fsp } from 'fs';
import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { getSecureStorage } from '../core/secureStorage';
import { assertSafeCustomBaseUrl } from '../../security/ssrfGuard';

export interface CustomVideoModel {
  id: string;
  label: string;
  /** 视频生成端点 base URL（已过 SSRF 守卫 + 去尾斜杠归一化）。 */
  baseUrl: string;
  /** 发给端点的 model 参数。 */
  modelName: string;
  /** 可选成本覆盖（元/条）。 */
  costCnyPerVideo?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CustomVideoModelInput {
  label: string;
  baseUrl: string;
  modelName: string;
  costCnyPerVideo?: number;
}

const STORE_FILE = 'custom-video-models.json';
// SecureStorage slot 前缀：key 存 apikey.custom-video:<id>，与 image（custom-image:）/内置 provider 隔离。
const KEY_PREFIX = 'custom-video:';

// 合法 id 形状：小写字母/数字开头，仅含小写 alnum 与连字符（deriveId 产出天然满足）。
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

function storePath(): string {
  return path.join(getUserConfigDir(), 'design', STORE_FILE);
}

function keySlot(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

interface StoreShape {
  models: CustomVideoModel[];
}

function sanitizeModel(value: unknown): CustomVideoModel | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !VALID_ID.test(v.id)) return null;
  if (typeof v.label !== 'string' || typeof v.baseUrl !== 'string' || typeof v.modelName !== 'string') return null;
  // 防御纵深：磁盘文件可能被篡改塞私网 baseUrl。读盘时也过一道 SSRF 守卫，不合规条目直接丢弃。
  try {
    assertSafeCustomBaseUrl(v.baseUrl);
  } catch {
    return null;
  }
  const model: CustomVideoModel = {
    id: v.id,
    label: v.label,
    baseUrl: v.baseUrl,
    modelName: v.modelName,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
  };
  if (typeof v.costCnyPerVideo === 'number' && Number.isFinite(v.costCnyPerVideo) && v.costCnyPerVideo >= 0) {
    model.costCnyPerVideo = v.costCnyPerVideo;
  }
  return model;
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fsp.readFile(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const models = Array.isArray(parsed.models)
      ? parsed.models.map(sanitizeModel).filter((m): m is CustomVideoModel => m !== null)
      : [];
    return { models };
  } catch {
    return { models: [] };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const dir = path.dirname(storePath());
  await fsp.mkdir(dir, { recursive: true });
  const json = JSON.stringify(store, null, 2);
  const tmp = `${storePath()}.${Date.now().toString(36)}.tmp`;
  try {
    await fsp.writeFile(tmp, json, 'utf-8');
    await fsp.rename(tmp, storePath());
  } catch {
    await fsp.writeFile(storePath(), json, 'utf-8');
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// id slug：label 取可保留的 [a-z0-9-]，非 ASCII（中文）丢弃后若空回退 'video'，加 6 位时戳尾缀去碰撞。
function deriveId(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const base = slug || 'video';
  const suffix = Date.now().toString(36).slice(-6);
  return `${base}-${suffix}`;
}

// 变更串行锁（防并发读改写丢更新），对齐 customImageModelRegistry。
let mutationChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 列出全部自定义生视频模型 metadata（不含 key）。 */
export async function listCustomVideoModels(): Promise<CustomVideoModel[]> {
  return (await readStore()).models;
}

/** 读单个自定义视频模型；不存在或 id 非法返回 null。 */
export async function getCustomVideoModel(id: string): Promise<CustomVideoModel | null> {
  if (!id || !VALID_ID.test(id)) return null;
  const { models } = await readStore();
  return models.find((m) => m.id === id) ?? null;
}

/**
 * 新建一个自定义生视频模型。校验 label/modelName 非空 + baseUrl 过 SSRF 守卫（归一化），
 * 派生 id 落盘。不支持单字段修改（删除重建），故总是 append 新条目。返回最终 id。
 */
export async function saveCustomVideoModel(input: CustomVideoModelInput): Promise<{ id: string }> {
  return withLock(() => saveImpl(input));
}

async function saveImpl(input: CustomVideoModelInput): Promise<{ id: string }> {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) throw new Error('自定义视频模型需要非空 label');
  const modelName = typeof input.modelName === 'string' ? input.modelName.trim() : '';
  if (!modelName) throw new Error('自定义视频模型需要非空 modelName');
  // SSRF 守卫 + 归一化（抛错则不落盘）。
  const baseUrl = assertSafeCustomBaseUrl(input.baseUrl);

  const now = Date.now();
  const store = await readStore();
  // 防 id 碰撞静默覆盖：deriveId 的时戳尾缀熵低，同 label 跨期可能撞 id。撞了追加去碰撞字符，绝不覆盖。
  let id = deriveId(label);
  let guard = 0;
  while (store.models.some((m) => m.id === id) && guard < 100) {
    id = `${id}-${(guard + 1).toString(36)}`;
    guard += 1;
  }
  const model: CustomVideoModel = { id, label, baseUrl, modelName, createdAt: now, updatedAt: now };
  if (typeof input.costCnyPerVideo === 'number' && Number.isFinite(input.costCnyPerVideo) && input.costCnyPerVideo >= 0) {
    model.costCnyPerVideo = input.costCnyPerVideo;
  }

  store.models = [...store.models.filter((m) => m.id !== id), model];
  await writeStore(store);
  return { id };
}

/** 删除一个自定义视频模型：移除 metadata + 清除 SecureStorage 里的 key。 */
export async function deleteCustomVideoModel(id: string): Promise<{ ok: true }> {
  return withLock(() => deleteImpl(id));
}

async function deleteImpl(id: string): Promise<{ ok: true }> {
  if (!id || !VALID_ID.test(id)) return { ok: true };
  const store = await readStore();
  if (!store.models.some((m) => m.id === id)) {
    deleteCustomVideoModelApiKey(id);
    return { ok: true };
  }
  store.models = store.models.filter((m) => m.id !== id);
  await writeStore(store);
  deleteCustomVideoModelApiKey(id);
  return { ok: true };
}

// ── API key（SecureStorage，CLI 模式不可用时防御性返回 undefined / 静默） ──

export function setCustomVideoModelApiKey(id: string, key: string): void {
  try {
    getSecureStorage().setApiKey(keySlot(id), key);
  } catch {
    // SecureStorage 在某些模式不可用——不让配置保存连坐崩溃。
  }
}

export function getCustomVideoModelApiKey(id: string): string | undefined {
  try {
    return getSecureStorage().getApiKey(keySlot(id)) || undefined;
  } catch {
    return undefined;
  }
}

export function deleteCustomVideoModelApiKey(id: string): void {
  try {
    getSecureStorage().deleteApiKey(keySlot(id));
  } catch {
    // 同上，防御性吞掉。
  }
}
