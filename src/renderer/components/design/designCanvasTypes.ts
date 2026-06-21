// 设计画布（Cowart 式）纯数据模型 + 序列化（无 React 依赖，可单测）。
// 画布存档落 run 目录下的 canvas.json；图片落 assets/，节点只存相对路径，
// 避免 JSON 内嵌 base64 膨胀（详见 docs/designs/design-canvas-cowart.md §2.2）。

/** 画布上的一张图节点。src 为相对 run 目录的图片路径（如 'assets/gen-123.png'）。 */
export interface CanvasImageNode {
  id: string;
  /** 相对 run 目录的图片路径，不内嵌 base64。 */
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 生成/编辑这张图的指令（历史与 A/B 对比用，可选）。 */
  prompt?: string;
  /** 它是从哪张图编辑而来（A/B 版本树用，可选；空=原始生成）。 */
  parentId?: string;
  /** 被选为该版本组的主版（A/B 对比后定稿）。 */
  chosen?: boolean;
  /** 软删除：淘汰但落盘保留（variant spine 非破坏性语义），画布渲染时过滤。 */
  discarded?: boolean;
  /** 用户为这一步命名的标题（T2 可逆命名步；空时历史展示回退到 prompt）。 */
  label?: string;
  /** 产出这一步的图像调用实际花费（人民币元，T2 BYOK 成本可见；权威值由出图 IPC 回传）。 */
  costCny?: number;
  createdAt: number;
}

/** 画布相机（平移 + 缩放）。 */
export interface CanvasCamera {
  x: number;
  y: number;
  scale: number;
}

/** 一次设计画布的完整存档（canvas.json 的内容）。 */
export interface DesignCanvasDoc {
  version: 1;
  nodes: CanvasImageNode[];
  camera: CanvasCamera;
}

export const CANVAS_DOC_VERSION = 1 as const;

/** 相机默认值：原点、1:1。 */
export const DEFAULT_CAMERA: CanvasCamera = { x: 0, y: 0, scale: 1 };

/** 空画布文档。 */
export function emptyCanvasDoc(): DesignCanvasDoc {
  return { version: CANVAS_DOC_VERSION, nodes: [], camera: { ...DEFAULT_CAMERA } };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验并规整一个节点；非法返回 null（由调用方过滤）。 */
function normalizeNode(raw: unknown): CanvasImageNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.src !== 'string' || r.src.length === 0) return null;
  if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
  const node: CanvasImageNode = {
    id: r.id,
    src: r.src,
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
    createdAt: isFiniteNumber(r.createdAt) ? (r.createdAt as number) : 0,
  };
  if (typeof r.prompt === 'string') node.prompt = r.prompt;
  if (typeof r.parentId === 'string') node.parentId = r.parentId;
  if (r.chosen === true) node.chosen = true;
  if (r.discarded === true) node.discarded = true;
  if (typeof r.label === 'string') node.label = r.label;
  if (isFiniteNumber(r.costCny)) node.costCny = r.costCny as number;
  return node;
}

function normalizeCamera(raw: unknown): CanvasCamera {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CAMERA };
  const r = raw as Record<string, unknown>;
  return {
    x: isFiniteNumber(r.x) ? (r.x as number) : DEFAULT_CAMERA.x,
    y: isFiniteNumber(r.y) ? (r.y as number) : DEFAULT_CAMERA.y,
    // scale 必须为正，否则回退 1，避免画布塌缩/翻转。
    scale: isFiniteNumber(r.scale) && (r.scale as number) > 0 ? (r.scale as number) : DEFAULT_CAMERA.scale,
  };
}

/** 序列化为 canvas.json 字符串。 */
export function serializeCanvasDoc(doc: DesignCanvasDoc): string {
  return JSON.stringify(
    { version: CANVAS_DOC_VERSION, nodes: doc.nodes, camera: doc.camera },
    null,
    2,
  );
}

/**
 * 从 canvas.json 字符串反序列化；任何破损/缺字段都安全降级到默认值，
 * 不抛异常（画布存档损坏不应让设计模式整个崩溃）。
 */
export function deserializeCanvasDoc(text: string | null | undefined): DesignCanvasDoc {
  if (!text) return emptyCanvasDoc();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyCanvasDoc();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyCanvasDoc();
  const p = parsed as Record<string, unknown>;
  const nodes = Array.isArray(p.nodes)
    ? p.nodes.map(normalizeNode).filter((n): n is CanvasImageNode => n !== null)
    : [];
  return { version: CANVAS_DOC_VERSION, nodes, camera: normalizeCamera(p.camera) };
}

/** 计算下一个新节点的落点：放在现有节点最右侧 +gap（移植 make-real 的 x:maxX+60）。 */
export function nextNodePlacement(
  nodes: readonly CanvasImageNode[],
  gap: number,
): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  let maxRight = -Infinity;
  let topY = 0;
  for (const n of nodes) {
    const right = n.x + n.width;
    if (right > maxRight) {
      maxRight = right;
      topY = n.y;
    }
  }
  return { x: maxRight + gap, y: topY };
}
