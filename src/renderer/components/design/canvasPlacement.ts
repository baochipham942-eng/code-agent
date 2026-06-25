import { DESIGN_WORKSPACE } from '@shared/constants';
import {
  isReferenceNode,
  type CanvasImageNode,
  type CanvasNode,
  type CanvasCamera,
} from './designCanvasTypes';
import { groupKey } from './variantSpine';

export type CanvasPlacementOperation =
  | 'root'
  | 'variant'
  | 'reference'
  | 'video'
  | 'expand'
  | 'removeWatermark'
  | 'annotation';

export interface CanvasPlacementInput {
  nodes: readonly CanvasNode[];
  size: { width: number; height: number };
  operation: CanvasPlacementOperation;
  baseNode?: CanvasNode | null;
  camera?: CanvasCamera;
  gap?: number;
}

type Rect = { x: number; y: number; width: number; height: number };

function activeNodes(nodes: readonly CanvasNode[]): CanvasNode[] {
  return nodes.filter((n) => !n.discarded);
}

function intersects(a: Rect, b: Rect, gap: number): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function avoidCollisions(candidate: Rect, nodes: readonly CanvasNode[], gap: number): { x: number; y: number } {
  const blockers = activeNodes(nodes);
  let next = { ...candidate };
  let guard = 0;
  while (blockers.some((n) => intersects(next, n, gap)) && guard < 200) {
    next = { ...next, y: next.y + next.height + gap };
    guard += 1;
  }
  return { x: next.x, y: next.y };
}

function viewportOrigin(camera: CanvasCamera | undefined): { x: number; y: number } {
  if (!camera || camera.scale <= 0 || !Number.isFinite(camera.scale)) return { x: 0, y: 0 };
  return { x: Math.round(-camera.x / camera.scale), y: Math.round(-camera.y / camera.scale) };
}

function rootPlacement(input: CanvasPlacementInput, gap: number): { x: number; y: number } {
  const nodes = activeNodes(input.nodes).filter((n) => !isReferenceNode(n));
  if (nodes.length === 0) return viewportOrigin(input.camera);
  const roots = nodes.filter((n) => !n.parentId);
  const basis = roots.length > 0 ? roots : nodes;
  const minX = Math.min(...basis.map((n) => n.x));
  const maxBottom = Math.max(...basis.map((n) => n.y + n.height));
  return avoidCollisions(
    { x: Number.isFinite(minX) ? minX : 0, y: maxBottom + gap, ...input.size },
    input.nodes,
    gap,
  );
}

function variantPlacement(input: CanvasPlacementInput, gap: number): { x: number; y: number } {
  const base = input.baseNode;
  if (!base) return rootPlacement(input, gap);
  const key = groupKey(base);
  const siblings = activeNodes(input.nodes).filter((n) => groupKey(n) === key);
  const chain = siblings.length > 0 ? siblings : [base];
  const maxRight = Math.max(...chain.map((n) => n.x + n.width));
  return avoidCollisions(
    { x: maxRight + gap, y: base.y, ...input.size },
    input.nodes,
    gap,
  );
}

function referencePlacement(input: CanvasPlacementInput, gap: number): { x: number; y: number } {
  const nodes = activeNodes(input.nodes);
  const references = nodes.filter(isReferenceNode);
  const outputs = nodes.filter((n) => !isReferenceNode(n));
  const productLeft = outputs.length > 0 ? Math.min(...outputs.map((n) => n.x)) : 0;
  const x = productLeft - input.size.width - gap;
  const y = references.length > 0 ? Math.max(...references.map((n) => n.y + n.height)) + gap : 0;
  return avoidCollisions({ x, y, ...input.size }, input.nodes, gap);
}

export function placeCanvasNode(input: CanvasPlacementInput): { x: number; y: number } {
  const gap = input.gap ?? DESIGN_WORKSPACE.CANVAS_NODE_GAP;
  if (input.operation === 'reference') return referencePlacement(input, gap);
  if (input.baseNode) return variantPlacement(input, gap);
  return rootPlacement(input, gap);
}

export function placeVariantNode(
  baseNode: CanvasImageNode,
  existingNodes: readonly CanvasNode[],
  size: { width: number; height: number },
  operation: CanvasPlacementOperation = 'variant',
): { x: number; y: number } {
  return placeCanvasNode({ nodes: existingNodes, baseNode, size, operation });
}
