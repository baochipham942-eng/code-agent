// ============================================================================
// Brand Registry（我的品牌契约 registry · CD-Parity §1）—— 独立服务模块
// ----------------------------------------------------------------------------
// 单机文件 registry，不进业务 DB（品牌是用户配置性资产，非强一致会话/账本数据）：
//   <getUserConfigDir>/design/brands/
//     index.json        { activeId?, brands: BrandMeta[] }
//     <id>/brand.json   完整 BrandContract
//     <id>/logo.png     可选（本模块只管 json，logo 由调用方落盘）
//
// 生成期强绑：enrichDesignBriefForPrompt 经 getActiveBrandSync() 读 active 品牌，
// hydrate 进 brief.directionTokens + brief.brandContract，复用现成三处注入/护栏。
// 写路径用 Date.now() 取 createdAt/updatedAt —— 这不是 DB repository（no-Date.now
// 规则针对 src/host/services/core/repositories），是文件型配置资产，可直接取时戳。
// ============================================================================

import { promises as fsp } from 'fs';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import {
  normalizeBrandContract,
  type BrandContract,
  type BrandMeta,
  type BrandRegistryIndex,
} from '../../../shared/contract/brandContract';

const INDEX_FILE = 'index.json';
const BRAND_FILE = 'brand.json';

function brandsRoot(): string {
  return path.join(getUserConfigDir(), 'design', 'brands');
}

function indexPath(): string {
  return path.join(brandsRoot(), INDEX_FILE);
}

// 合法 id 形状：小写字母/数字开头，仅含小写 alnum 与连字符。无点、无斜杠、无大写，
// deriveBrandId 的产出天然满足。caller 显式给的脏 id（穿越/大小写/点斜杠）一律拒。
const VALID_BRAND_ID = /^[a-z0-9][a-z0-9-]*$/;

function isValidBrandId(id: string): boolean {
  return VALID_BRAND_ID.test(id);
}

// 校验 + 防穿越：先按形状判，再确认 path.resolve 后仍落在 brandsRoot() 内（belt-and-suspenders）。
function assertSafeBrandId(id: string): void {
  if (!isValidBrandId(id)) {
    throw new Error(`非法品牌 id（仅允许小写字母数字与连字符）：${id}`);
  }
  const root = path.resolve(brandsRoot());
  const dir = path.resolve(brandsRoot(), id);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`品牌 id 越界（解析路径逃出 brands 目录）：${id}`);
  }
}

function brandDir(id: string): string {
  return path.join(brandsRoot(), id);
}

function brandJsonPath(id: string): string {
  return path.join(brandDir(id), BRAND_FILE);
}

function metaFromBrand(brand: BrandContract): BrandMeta {
  return { id: brand.id, name: brand.name, updatedAt: brand.updatedAt };
}

// id slug：name 取拼音以外可保留的 [a-z0-9-]，中文等非 ASCII 字符丢弃后若空则回退 'brand'，
// 加 6 位时戳尾缀去碰撞。registry 自用、人读友好即可。
function deriveBrandId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const base = slug || 'brand';
  const suffix = Date.now().toString(36).slice(-6);
  return `${base}-${suffix}`;
}

async function readIndex(): Promise<BrandRegistryIndex> {
  try {
    const raw = await fsp.readFile(indexPath(), 'utf-8');
    return parseIndex(raw);
  } catch {
    return { brands: [] };
  }
}

function parseIndex(raw: string): BrandRegistryIndex {
  try {
    const parsed = JSON.parse(raw) as Partial<BrandRegistryIndex>;
    const brands = Array.isArray(parsed.brands)
      ? parsed.brands
          .filter((b): b is BrandMeta => Boolean(b && typeof b.id === 'string' && typeof b.name === 'string'))
          .map((b) => ({ id: b.id, name: b.name, updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0 }))
      : [];
    const activeId = typeof parsed.activeId === 'string' && brands.some((b) => b.id === parsed.activeId)
      ? parsed.activeId
      : undefined;
    const index: BrandRegistryIndex = { brands };
    if (activeId) index.activeId = activeId;
    return index;
  } catch {
    return { brands: [] };
  }
}

async function writeIndex(index: BrandRegistryIndex): Promise<void> {
  await fsp.mkdir(brandsRoot(), { recursive: true });
  await writeJsonAtomic(indexPath(), index);
}

// 准原子写：先写临时文件再 rename（同目录 rename 在多数 fs 上原子），失败回退普通写。
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.${Date.now().toString(36)}.tmp`;
  try {
    await fsp.writeFile(tmp, json, 'utf-8');
    await fsp.rename(tmp, filePath);
  } catch {
    await fsp.writeFile(filePath, json, 'utf-8');
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// index.json 变更串行锁（MED-2 修复）：saveBrand/deleteBrand/setActiveBrand 都是
// readIndex→改→writeIndex 的读改写，含 await 点；并发触发会丢更新（后写者覆盖前写者的
// index，产生孤儿品牌）。准原子写只保证单次写原子，挡不住读改写竞态。用模块级 promise 链
// 把所有 index 变更串成一条队列。读路径(listBrands/getBrand/getActiveBrand)不上锁——tmp+rename
// 保证读到的要么旧要么新，不会半行。
let indexMutationChain: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexMutationChain.then(fn, fn);
  // 链尾吞掉 rejection，避免一次失败把后续排队的变更全连坐拒绝。
  indexMutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 列出所有品牌元数据 + 当前 active id。 */
export async function listBrands(): Promise<BrandRegistryIndex> {
  return readIndex();
}

/** 读单个品牌完整契约；不存在或损坏返回 null。 */
export async function getBrand(id: string): Promise<BrandContract | null> {
  if (!id || !isValidBrandId(id)) return null;
  try {
    const raw = await fsp.readFile(brandJsonPath(id), 'utf-8');
    return normalizeBrandContract(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

/**
 * 写入/更新一份品牌。无 id 则派生新 id（新建），有 id 则覆盖（编辑）。
 * 落盘 brand.json + upsert index 元数据。返回最终 id。
 */
export async function saveBrand(brand: Partial<BrandContract>): Promise<{ id: string }> {
  return withIndexLock(() => saveBrandImpl(brand));
}

async function saveBrandImpl(brand: Partial<BrandContract>): Promise<{ id: string }> {
  const now = Date.now();
  const name = typeof brand.name === 'string' ? brand.name.trim() : '';
  if (!name) {
    throw new Error('saveBrand 需要非空 name');
  }
  const id = (typeof brand.id === 'string' && brand.id.trim()) || deriveBrandId(name);
  // 显式脏 id 直接拒（deriveBrandId 产出天然合法，不会触发）；并 belt-and-suspenders 防穿越。
  assertSafeBrandId(id);
  const existing = await getBrand(id);
  const createdAt = existing?.createdAt ?? (typeof brand.createdAt === 'number' ? brand.createdAt : now);

  const normalized = normalizeBrandContract({
    ...brand,
    id,
    name,
    createdAt,
    updatedAt: now,
  });
  if (!normalized) {
    throw new Error('saveBrand 校验失败：tokens 不合法或缺字段');
  }

  await fsp.mkdir(brandDir(id), { recursive: true });
  await writeJsonAtomic(brandJsonPath(id), normalized);

  const index = await readIndex();
  const meta = metaFromBrand(normalized);
  const others = index.brands.filter((b) => b.id !== id);
  const nextIndex: BrandRegistryIndex = { brands: [...others, meta] };
  if (index.activeId) nextIndex.activeId = index.activeId;
  await writeIndex(nextIndex);

  return { id };
}

/** 删除一个品牌：移除目录 + index 条目；若它是 active 则清空 active。 */
export async function deleteBrand(id: string): Promise<{ ok: true }> {
  return withIndexLock(() => deleteBrandImpl(id));
}

async function deleteBrandImpl(id: string): Promise<{ ok: true }> {
  if (!id || !isValidBrandId(id)) return { ok: true };
  const index = await readIndex();
  // 只删 index 里确实登记的 id：杜绝穿越/孤儿目录被误删（即便形状合法）。
  if (!index.brands.some((b) => b.id === id)) return { ok: true };
  // belt-and-suspenders：rm 前再确认解析路径仍在 brands 内。
  assertSafeBrandId(id);
  await fsp.rm(brandDir(id), { recursive: true, force: true }).catch(() => undefined);
  const brands = index.brands.filter((b) => b.id !== id);
  const nextIndex: BrandRegistryIndex = { brands };
  if (index.activeId && index.activeId !== id) nextIndex.activeId = index.activeId;
  await writeIndex(nextIndex);
  return { ok: true };
}

/** 设置/清空 active 品牌。传入不存在的 id 视为清空（不报错，保持 index 自洽）。 */
export async function setActiveBrand(id: string | null): Promise<{ ok: true }> {
  return withIndexLock(() => setActiveBrandImpl(id));
}

async function setActiveBrandImpl(id: string | null): Promise<{ ok: true }> {
  const index = await readIndex();
  const nextIndex: BrandRegistryIndex = { brands: index.brands };
  if (id && index.brands.some((b) => b.id === id)) {
    nextIndex.activeId = id;
  }
  await writeIndex(nextIndex);
  return { ok: true };
}

/** 取当前 active 品牌完整契约（异步），无则 null。 */
export async function getActiveBrand(): Promise<BrandContract | null> {
  const index = await readIndex();
  if (!index.activeId) return null;
  return getBrand(index.activeId);
}

/**
 * 同步取 active 品牌——供 enrichDesignBriefForPrompt（同步链路，与 readDesignMdSummary
 * 同风格用 readFileSync）强绑注入用。读小 json，主进程同步可接受。任何异常/缺失返回 null。
 */
export function getActiveBrandSync(): BrandContract | null {
  try {
    if (!existsSync(indexPath())) return null;
    const index = parseIndex(readFileSync(indexPath(), 'utf-8'));
    if (!index.activeId) return null;
    const jsonPath = brandJsonPath(index.activeId);
    if (!existsSync(jsonPath)) return null;
    return normalizeBrandContract(JSON.parse(readFileSync(jsonPath, 'utf-8'))) ?? null;
  } catch {
    return null;
  }
}
