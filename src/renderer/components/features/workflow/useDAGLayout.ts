// ============================================================================
// useDAGLayout - Dagre 自动布局 Hook
// Session 5: React Flow 可视化
// ============================================================================

import { useCallback, useMemo } from 'react';
import dagre from 'dagre';
import type { TaskNode, DependencyEdge, DAGLayoutOptions } from '../../../../shared/types/dagVisualization';
import { DEFAULT_LAYOUT_OPTIONS } from '../../../../shared/types/dagVisualization';

/**
 * 节点尺寸
 */
const NODE_WIDTH = 240;
const NODE_HEIGHT = 140;

/**
 * 默认空对象（避免每次渲染创建新引用导致无限循环）
 */
const EMPTY_OPTIONS: Partial<DAGLayoutOptions> = {};

/**
 * 使用 Dagre 进行 DAG 自动布局
 */
export function useDAGLayout(options: Partial<DAGLayoutOptions> = EMPTY_OPTIONS) {
  const layoutOptions = useMemo(
    () => ({ ...DEFAULT_LAYOUT_OPTIONS, ...options }),
    [options]
  );

  /**
   * 计算布局
   */
  const getLayoutedElements = useCallback(
    (nodes: TaskNode[], edges: DependencyEdge[]) => {
      if (nodes.length === 0) {
        return { nodes: [], edges: [] };
      }

      // 创建 dagre 图
      const dagreGraph = new dagre.graphlib.Graph();
      dagreGraph.setDefaultEdgeLabel(() => ({}));
      dagreGraph.setGraph({
        rankdir: layoutOptions.direction,
        nodesep: layoutOptions.nodeSpacing,
        ranksep: layoutOptions.rankSpacing,
        marginx: 20,
        marginy: 20,
      });

      // 添加节点
      nodes.forEach((node) => {
        dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
      });

      // 添加边
      edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
      });

      // 计算布局
      dagre.layout(dagreGraph);

      // 应用布局到节点
      const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        return {
          ...node,
          position: {
            x: nodeWithPosition.x - NODE_WIDTH / 2,
            y: nodeWithPosition.y - NODE_HEIGHT / 2,
          },
        };
      });

      return { nodes: layoutedNodes, edges };
    },
    [layoutOptions]
  );

  /**
   * 获取图的边界框
   */
  const getGraphBounds = useCallback((nodes: TaskNode[]) => {
    if (nodes.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((node) => {
      const { x, y } = node.position || { x: 0, y: 0 };
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_WIDTH);
      maxY = Math.max(maxY, y + NODE_HEIGHT);
    });

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, []);

  return {
    getLayoutedElements,
    getGraphBounds,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
  };
}

export default useDAGLayout;
