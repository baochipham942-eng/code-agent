// 设计画布（Cowart 式）纯数据模型 + 序列化（无 React 依赖，可单测）。
// 画布存档落 run 目录下的 canvas.json；图片落 assets/，节点只存相对路径，
// 避免 JSON 内嵌 base64 膨胀（详见 内部文档 §2.2）。
import type { RegionLockReport } from '@shared/contract/imageConsistency';
import {
  normalizeConnector,
  normalizeShape,
  pruneDanglingConnectors,
  type CanvasConnector,
  type CanvasShape,
} from './designDiagramTypes';

/** 视频节点的默认时长（秒），当 durationSec 缺失或非正时回退。 */
export const DEFAULT_VIDEO_DURATION_SEC = 5;

/** 画布节点公共基础字段（图像节点与视频节点共享）。 */
export interface CanvasNodeBase {
  id: string;
  /** 相对 run 目录的媒体文件路径（图片或视频，不内嵌 base64）。 */
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 生成/编辑这张图/段视频的指令（历史与 A/B 对比用，可选）。 */
  prompt?: string;
  /** 它是从哪张图编辑而来（A/B 版本树用，可选；空=原始生成）。 */
  parentId?: string;
  /** 被选为该版本组的主版（A/B 对比后定稿）。 */
  chosen?: boolean;
  /** 软删除：淘汰但落盘保留（variant spine 非破坏性语义），画布渲染时过滤。 */
  discarded?: boolean;
  /** 用户为这一步命名的标题（T2 可逆命名步；空时历史展示回退到 prompt）。 */
  label?: string;
  /** 产出这一步的调用实际花费（人民币元，T2 BYOK 成本可见；权威值由出图 IPC 回传）。 */
  costCny?: number;
  /**
   * 节点角色：'reference'=用户生成前贴入的参考图（喂模型用，不进版本时间线序号）；
   * 缺省视为产物（生成/编辑输出）。紧凑落盘：仅 reference 落字段，产物不落。
   */
  role?: 'reference' | 'output';
  createdAt: number;
}

/** 画布上的一张图节点。src 为相对 run 目录的图片路径（如 'assets/gen-123.png'）。 */
export interface CanvasImageNode extends CanvasNodeBase {
  /** 图节点类型标识（可选，省略时按 src 后缀推断；兼容历史数据）。 */
  kind?: 'image';
  /** T4 局部重绘一致性报告（未选区域是否守住 + diff 证据，仅 edit 产物有）。 */
  consistency?: RegionLockReport;
}

/** 画布上的一段视频节点。src 为相对 run 目录的视频路径（如 'assets/gen-123.mp4'）。 */
export interface CanvasVideoNode extends CanvasNodeBase {
  /** 视频节点类型标识（判别联合必填字段）。 */
  kind: 'video';
  /** 视频封面图路径（可选，用于画布静态预览）。 */
  poster?: string;
  /** 视频时长（秒，必须为正数；缺失时回退到 DEFAULT_VIDEO_DURATION_SEC）。 */
  durationSec: number;
}

/** 画布节点判别联合：图像节点 | 视频节点。 */
export type CanvasNode = CanvasImageNode | CanvasVideoNode;

/** 画布相机（平移 + 缩放）。 */
export interface CanvasCamera {
  x: number;
  y: number;
  scale: number;
}

/** 一次设计画布的完整存档（canvas.json 的内容）。 */
export interface DesignCanvasDoc {
  version: 1;
  nodes: CanvasNode[];
  /**
   * 图解层连线（加法字段，老存档缺失自然降级为空）。节点↔节点，渲染时实时算锚点。
   * 紧凑落盘：仅非空时序列化，避免老档/无图解画布平白多出空数组。
   */
  connectors?: CanvasConnector[];
  /** 图解层 freeform 形状（加法字段，同上）。 */
  shapes?: CanvasShape[];
  camera: CanvasCamera;
}

export const CANVAS_DOC_VERSION = 1 as const;

/** 相机默认值：原点、1:1。 */
export const DEFAULT_CAMERA: CanvasCamera = { x: 0, y: 0, scale: 1 };

/** 空画布文档。 */
export function emptyCanvasDoc(): DesignCanvasDoc {
  return { version: CANVAS_DOC_VERSION, nodes: [], camera: { ...DEFAULT_CAMERA } };
}

/** 判断节点是否为视频节点（kind='video' 或 src 以 .mp4 结尾兼容老数据）。 */
export function isVideoNode(n: CanvasNode): n is CanvasVideoNode {
  return n.kind === 'video' || (n.kind === undefined && /\.mp4$/i.test(n.src));
}

/** 判断节点是否为图像节点（非视频节点即为图像节点）。 */
export function isImageNode(n: CanvasNode): n is CanvasImageNode {
  return !isVideoNode(n);
}

/** 判断节点是否为参考图（生成前贴入，喂模型用，不计入版本时间线序号）。 */
export function isReferenceNode(n: CanvasNode): boolean {
  return n.role === 'reference';
}

/**
 * 格式化视频时长标签。
 * @param sec - 时长（秒）
 * @returns 如 '5s'
 */
export function formatDurationLabel(sec: number): string {
  const rounded = sec > 0 && Number.isFinite(sec) ? Math.round(sec) : 0;
  return `${rounded}s`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 规整公共基础字段（图像/视频节点共用）；校验失败返回 null。 */
function normalizeBase(r: Record<string, unknown>): CanvasNodeBase | null {
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.src !== 'string' || r.src.length === 0) return null;
  if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
  const base: CanvasNodeBase = {
    id: r.id,
    src: r.src,
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
    createdAt: isFiniteNumber(r.createdAt) ? (r.createdAt as number) : 0,
  };
  if (typeof r.prompt === 'string') base.prompt = r.prompt;
  if (typeof r.parentId === 'string') base.parentId = r.parentId;
  if (r.chosen === true) base.chosen = true;
  if (r.discarded === true) base.discarded = true;
  if (typeof r.label === 'string') base.label = r.label;
  // 仅 reference 落盘（产物为缺省态，保持紧凑）；非法值丢弃防破损注入。
  if (r.role === 'reference') base.role = 'reference';
  // 成本必须非负：防手改/损坏的 canvas.json 注入负成本压低累计花费、破坏 BYOK 计费信任。
  if (isFiniteNumber(r.costCny) && (r.costCny as number) >= 0) base.costCny = r.costCny as number;
  return base;
}

/** 校验并规整一个节点；非法返回 null（由调用方过滤）。 */
function normalizeNode(raw: unknown): CanvasNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const base = normalizeBase(r);
  if (!base) return null;

  // 判断是否为视频节点：kind='video' 或 src 以 .mp4 结尾
  if (r.kind === 'video' || (r.kind === undefined && /\.mp4$/i.test(base.src))) {
    const durationSec =
      isFiniteNumber(r.durationSec) && (r.durationSec as number) > 0
        ? (r.durationSec as number)
        : DEFAULT_VIDEO_DURATION_SEC;
    const videoNode: CanvasVideoNode = { ...base, kind: 'video', durationSec };
    if (typeof r.poster === 'string' && r.poster.length > 0) videoNode.poster = r.poster;
    return videoNode;
  }

  // 图像节点
  const imageNode: CanvasImageNode = { ...base };
  if (r.kind === 'image') imageNode.kind = 'image';
  const consistency = normalizeConsistency(r.consistency);
  if (consistency) imageNode.consistency = consistency;
  return imageNode;
}

/** 校验并规整 canvas.json 里的一致性报告；字段缺失/破损返回 null（安全降级）。 */
function normalizeConsistency(raw: unknown): RegionLockReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.status !== 'clean' && r.status !== 'locked') return null;
  if (typeof r.passed !== 'boolean') return null;
  const report: RegionLockReport = {
    passed: r.passed,
    status: r.status,
    maxDelta: isFiniteNumber(r.maxDelta) ? (r.maxDelta as number) : 0,
    meanDelta: isFiniteNumber(r.meanDelta) ? (r.meanDelta as number) : 0,
    changedPixels: isFiniteNumber(r.changedPixels) ? (r.changedPixels as number) : 0,
    keepPixels: isFiniteNumber(r.keepPixels) ? (r.keepPixels as number) : 0,
    epsilon: isFiniteNumber(r.epsilon) ? (r.epsilon as number) : 0,
    dimensionMatched: r.dimensionMatched !== false,
  };
  if (typeof r.diffPath === 'string' && r.diffPath.length > 0) report.diffPath = r.diffPath;
  return report;
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

/** 序列化为 canvas.json 字符串。图解层（connectors/shapes）仅非空时落盘，保持紧凑。 */
export function serializeCanvasDoc(doc: DesignCanvasDoc): string {
  const out: {
    version: typeof CANVAS_DOC_VERSION;
    nodes: CanvasNode[];
    connectors?: CanvasConnector[];
    shapes?: CanvasShape[];
    camera: CanvasCamera;
  } = { version: CANVAS_DOC_VERSION, nodes: doc.nodes, camera: doc.camera };
  if (doc.connectors && doc.connectors.length > 0) out.connectors = doc.connectors;
  if (doc.shapes && doc.shapes.length > 0) out.shapes = doc.shapes;
  return JSON.stringify(out, null, 2);
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
    ? p.nodes.map(normalizeNode).filter((n): n is CanvasNode => n !== null)
    : [];
  const doc: DesignCanvasDoc = { version: CANVAS_DOC_VERSION, nodes, camera: normalizeCamera(p.camera) };
  // 图解层（加法字段）：归一化 + 过滤悬空连线（端点节点必须存在）；仅非空时挂上，保持紧凑。
  const nodeIds = new Set(nodes.map((n) => n.id));
  const connectors = Array.isArray(p.connectors)
    ? pruneDanglingConnectors(
        p.connectors.map(normalizeConnector).filter((c): c is CanvasConnector => c !== null),
        nodeIds,
      )
    : [];
  if (connectors.length > 0) doc.connectors = connectors;
  const shapes = Array.isArray(p.shapes)
    ? p.shapes.map(normalizeShape).filter((s): s is CanvasShape => s !== null)
    : [];
  if (shapes.length > 0) doc.shapes = shapes;
  return doc;
}

/** 计算下一个新节点的落点：放在现有节点最右侧 +gap（移植 make-real 的 x:maxX+60）。 */
export function nextNodePlacement(
  nodes: readonly CanvasNode[],
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

/**
 * 计算把全部节点 bbox 居中并缩放到适配视口的相机（留 padding）。
 * 用于「节点新增时自动 fit-to-view」，避免出图回灌后内容跑出视口看不见。
 * 屏幕变换约定：screen = world * scale + camera.{x,y}（与 Stage x/y/scale 一致）。
 * - scale = min(viewW/bboxW, viewH/bboxH) * padding（留边，默认 0.9）
 * - 把 bbox 中心映射到视口中心：camera.{x,y} = view/2 - bboxCenter * scale
 * 退化 bbox（单点/零尺寸）只居中不缩放；空集 / 无效视口返回 null。
 */
export function computeFitCamera(
  nodes: readonly CanvasNode[],
  viewW: number,
  viewH: number,
  padding = 0.9,
): CanvasCamera | null {
  if (nodes.length === 0 || viewW <= 0 || viewH <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  // 退化 bbox（单点/零尺寸）：不缩放，仅居中。
  const scale = bboxW > 0 && bboxH > 0 ? Math.min(viewW / bboxW, viewH / bboxH) * padding : 1;
  const cx = minX + bboxW / 2;
  const cy = minY + bboxH / 2;
  return { scale, x: viewW / 2 - cx * scale, y: viewH / 2 - cy * scale };
}
