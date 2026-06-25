import {
  isImageNode,
  isReferenceNode,
  isVideoNode,
  type CanvasNode,
} from './designCanvasTypes';
import { groupKey } from './variantSpine';

export type DesignSelectionNodeType = 'image' | 'video';

export interface DesignSelectionContextNode {
  id: string;
  type: DesignSelectionNodeType;
  src: string;
  bounds: { x: number; y: number; width: number; height: number };
  label?: string;
  prompt?: string;
  parentId?: string;
  groupId: string;
  chosen: boolean;
  role: 'reference' | 'output';
}

export interface DesignSelectionContext {
  selectedIds: string[];
  nodes: DesignSelectionContextNode[];
  primary?: DesignSelectionContextNode;
  multi: boolean;
  summary: string;
}

function toContextNode(node: CanvasNode): DesignSelectionContextNode | null {
  const type: DesignSelectionNodeType = isVideoNode(node) ? 'video' : isImageNode(node) ? 'image' : 'image';
  if (type !== 'image' && type !== 'video') return null;
  return {
    id: node.id,
    type,
    src: node.src,
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    ...(node.label ? { label: node.label } : {}),
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    groupId: groupKey(node),
    chosen: node.chosen === true,
    role: isReferenceNode(node) ? 'reference' : 'output',
  };
}

export function buildDesignSelectionContext(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
): DesignSelectionContext | null {
  const byId = new Map(nodes.filter((n) => !n.discarded).map((node) => [node.id, node]));
  const selected = selectedIds
    .map((id) => byId.get(id))
    .filter((node): node is CanvasNode => Boolean(node))
    .map(toContextNode)
    .filter((node): node is DesignSelectionContextNode => node !== null);
  if (selected.length === 0) return null;
  const summary = selected
    .map((node) => `${node.type}:${node.label || node.prompt || node.id}`)
    .join(' | ');
  return {
    selectedIds: selected.map((node) => node.id),
    nodes: selected,
    primary: selected[0],
    multi: selected.length > 1,
    summary,
  };
}

export function selectionPromptHint(context: DesignSelectionContext | null | undefined): string | undefined {
  if (!context || context.nodes.length === 0) return undefined;
  const lines = [
    `当前画布选中 ${context.nodes.length} 个对象：`,
    ...context.nodes.map((node, index) => {
      const title = node.label || node.prompt || node.id;
      return `${index + 1}. ${node.type} ${node.id} (${node.role}) ${title} ` +
        `bounds=${Math.round(node.bounds.x)},${Math.round(node.bounds.y)},${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)}`;
    }),
    '这次生成/修改应优先围绕上述选中对象，不要让模型只靠用户口头描述猜目标。',
  ];
  return lines.join('\n');
}

export function firstSelectedImageNode(
  nodes: readonly CanvasNode[],
  context: DesignSelectionContext | null | undefined,
): CanvasNode | undefined {
  const id = context?.nodes.find((node) => node.type === 'image')?.id;
  return id ? nodes.find((node) => node.id === id && isImageNode(node) && !node.discarded) : undefined;
}
