// 非破坏性 variant spine（统一版本模型，无 React 依赖，可单测）。
// canvas（图像节点树）与 proto（HTML 版本快照）共用同一 Variant 抽象：
// 每个 op 产物落为新 pinned variant，永不覆盖；淘汰是软删除（discarded），落盘保留。
// 「版本槽」语义：groupKey = parentId ?? id —— 一张原图与它的直接编辑产物同槽，
// 槽内单选主版（pinned）；不同根产物各自独立槽，互不影响。

export type VariantKind = 'canvas-image' | 'proto-html';

/** 图像类产物的载荷（落画布，相对 run 目录的图片路径）。 */
export interface CanvasImagePayload {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 交互原型产物的载荷（HTML 版本快照路径）。 */
export interface ProtoHtmlPayload {
  htmlPath: string;
}

export type VariantPayload = CanvasImagePayload | ProtoHtmlPayload;

/** 统一 variant：canvas 与 proto 两套产物的共同抽象。 */
export interface Variant {
  id: string;
  kind: VariantKind;
  /** 它从哪个 variant 派生而来（版本树边；空=根产物）。 */
  parentId?: string;
  /** 被选为该版本槽的主版。 */
  pinned: boolean;
  /** 软删除：淘汰但落盘保留，永不真删。 */
  discarded: boolean;
  createdAt: number;
  /** 产出它的操作（generate/edit/continueEdit/expand…，可选）。 */
  op?: string;
  /** 生成/编辑指令或标题（对比与历史用，可选）。 */
  label?: string;
  payload: VariantPayload;
}

/** 一条设计 run 的 variant spine（spine.json 的内容）。 */
export interface VariantSpine {
  version: 1;
  variants: Variant[];
}

export const SPINE_VERSION = 1 as const;

const KINDS: readonly VariantKind[] = ['canvas-image', 'proto-html'];

/** 版本槽 key：根以自身 id 为组，派生产物以 parentId 归入原图同槽。 */
export function groupKey(v: Pick<Variant, 'id' | 'parentId'>): string {
  return v.parentId ?? v.id;
}

export function emptySpine(): VariantSpine {
  return { version: SPINE_VERSION, variants: [] };
}

export function getVariant(spine: VariantSpine, id: string): Variant | undefined {
  return spine.variants.find((v) => v.id === id);
}

/** 取消同槽其余 variant 的 pinned（不动被 pin 的目标，也不动跨槽）。 */
function unpinSiblings(variants: Variant[], key: string, exceptId: string): Variant[] {
  return variants.map((v) =>
    v.id !== exceptId && groupKey(v) === key && v.pinned ? { ...v, pinned: false } : v,
  );
}

/**
 * 追加一个新产物：入栈即 pinned，同槽旧版自动取消 pinned 但全部保留（永不覆盖）。
 * 入参 variant 的 pinned/discarded 由本函数规整（pinned=true, discarded=false）。
 */
export function appendVariant(spine: VariantSpine, v: Variant): VariantSpine {
  const fresh: Variant = { ...v, pinned: true, discarded: false };
  const key = groupKey(fresh);
  const cleared = unpinSiblings(spine.variants, key, fresh.id);
  return { ...spine, variants: [...cleared, fresh] };
}

/** 设主版：pin 目标，取消同槽其余；目标不存在则原样返回。 */
export function pinVariant(spine: VariantSpine, id: string): VariantSpine {
  const target = getVariant(spine, id);
  if (!target) return spine;
  const key = groupKey(target);
  const variants = spine.variants.map((v) =>
    v.id === id ? { ...v, pinned: true } : v,
  );
  return { ...spine, variants: unpinSiblings(variants, key, id) };
}

/**
 * 淘汰（软删除）：标 discarded=true 但保留；若淘汰的是当前主版，
 * 自动把同槽最新的活跃版升为主版（保证槽内仍有主版可定稿）。
 */
export function discardVariant(spine: VariantSpine, id: string): VariantSpine {
  const target = getVariant(spine, id);
  if (!target) return spine;
  // 淘汰即清掉自身 pinned：否则之后 restore 回来会与已升任的主版形成同槽双主版。
  let variants = spine.variants.map((v) =>
    v.id === id ? { ...v, discarded: true, pinned: false } : v,
  );
  if (target.pinned) {
    const key = groupKey(target);
    const promote = variants
      .filter((v) => v.id !== id && !v.discarded && groupKey(v) === key)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (promote) {
      variants = variants.map((v) => (v.id === promote.id ? { ...v, pinned: true } : v));
    }
  }
  return { ...spine, variants };
}

/** 撤销淘汰。 */
export function restoreVariant(spine: VariantSpine, id: string): VariantSpine {
  return {
    ...spine,
    variants: spine.variants.map((v) => (v.id === id ? { ...v, discarded: false } : v)),
  };
}

/** 活跃（未淘汰）variant。 */
export function activeVariants(spine: VariantSpine): Variant[] {
  return spine.variants.filter((v) => !v.discarded);
}

/** 与目标同槽的活跃 variant（含目标自身）。 */
export function siblingGroup(spine: VariantSpine, id: string): Variant[] {
  const target = getVariant(spine, id);
  if (!target) return [];
  const key = groupKey(target);
  return activeVariants(spine).filter((v) => groupKey(v) === key);
}

/** 某槽内的 pinned 活跃 variant。 */
export function pinnedInGroup(spine: VariantSpine, key: string): Variant | undefined {
  return activeVariants(spine).find((v) => groupKey(v) === key && v.pinned);
}

export function serializeSpine(spine: VariantSpine): string {
  return JSON.stringify({ version: SPINE_VERSION, variants: spine.variants }, null, 2);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizePayload(kind: VariantKind, raw: unknown): VariantPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (kind === 'canvas-image') {
    if (typeof r.src !== 'string' || r.src.length === 0) return null;
    if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
    return {
      src: r.src,
      x: r.x as number,
      y: r.y as number,
      width: r.width as number,
      height: r.height as number,
    };
  }
  if (typeof r.htmlPath !== 'string' || r.htmlPath.length === 0) return null;
  return { htmlPath: r.htmlPath };
}

/** 校验并规整一个 variant；非法返回 null（由调用方过滤）。 */
function normalizeVariant(raw: unknown): Variant | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind as VariantKind)) return null;
  const payload = normalizePayload(r.kind as VariantKind, r.payload);
  if (!payload) return null;
  const v: Variant = {
    id: r.id,
    kind: r.kind as VariantKind,
    pinned: r.pinned === true,
    discarded: r.discarded === true,
    createdAt: isFiniteNumber(r.createdAt) ? (r.createdAt as number) : 0,
    payload,
  };
  if (typeof r.parentId === 'string') v.parentId = r.parentId;
  if (typeof r.op === 'string') v.op = r.op;
  if (typeof r.label === 'string') v.label = r.label;
  return v;
}

export function deserializeSpine(text: string | null | undefined): VariantSpine {
  if (!text) return emptySpine();
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return emptySpine();
    const arr = (raw as Record<string, unknown>).variants;
    if (!Array.isArray(arr)) return emptySpine();
    const variants = arr.map(normalizeVariant).filter((v): v is Variant => v !== null);
    return { version: SPINE_VERSION, variants };
  } catch {
    return emptySpine();
  }
}
