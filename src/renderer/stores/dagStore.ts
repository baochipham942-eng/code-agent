// ============================================================================
// DAG Store - DAG 可视化状态管理
// Session 5: React Flow 可视化
//
// 性能优化：
// 1. 使用 Map 索引加速任务查找（O(1) vs O(n)）
// 2. 边的索引加速依赖关系查找
// 3. 细粒度选择器减少重渲染
// ============================================================================

import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type {
  DAGVisualizationState,
  DAGVisualizationEvent,
  TaskStatusEventData,
  TaskProgressEventData,
  StatisticsUpdateEventData,
  TaskNode,
  DependencyEdge,
  TaskNodeData,
} from '@shared/types/dagVisualization';
import type { DAGStatus, DAGStatistics, TaskStatus } from '@shared/types/taskDAG';
import { createLogger } from '../utils/logger';

const logger = createLogger('DAGStore');

// ----------------------------------------------------------------------------
// 性能优化：索引结构
// ----------------------------------------------------------------------------

/** 每个 DAG 的索引缓存 */
interface DAGIndex {
  /** taskId -> node 索引位置 */
  nodeIndexByTaskId: Map<string, number>;
  /** taskId -> 出边列表 */
  edgesBySource: Map<string, number[]>;
  /** taskId -> 入边列表 */
  edgesByTarget: Map<string, number[]>;
}

/** 全局索引缓存 */
const dagIndexCache = new Map<string, DAGIndex>();

/** 构建 DAG 索引 */
function buildDAGIndex(dag: DAGVisualizationState): DAGIndex {
  const nodeIndexByTaskId = new Map<string, number>();
  const edgesBySource = new Map<string, number[]>();
  const edgesByTarget = new Map<string, number[]>();

  dag.nodes.forEach((node, index) => {
    nodeIndexByTaskId.set(node.data.taskId, index);
  });

  dag.edges.forEach((edge, index) => {
    const sourceEdges = edgesBySource.get(edge.source) || [];
    sourceEdges.push(index);
    edgesBySource.set(edge.source, sourceEdges);

    const targetEdges = edgesByTarget.get(edge.target) || [];
    targetEdges.push(index);
    edgesByTarget.set(edge.target, targetEdges);
  });

  return { nodeIndexByTaskId, edgesBySource, edgesByTarget };
}

/** 获取或创建 DAG 索引 */
function getDAGIndex(dagId: string, dag: DAGVisualizationState): DAGIndex {
  let index = dagIndexCache.get(dagId);
  if (!index) {
    index = buildDAGIndex(dag);
    dagIndexCache.set(dagId, index);
  }
  return index;
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface DAGStoreState {
  /** 当前活跃的 DAG（可能有多个，用 dagId 索引） */
  dags: Map<string, DAGVisualizationState>;
  /** 当前选中查看的 DAG ID */
  currentDagId: string | null;
  /** 是否显示 DAG 面板 */
  isVisible: boolean;
  /** 初始化状态 */
  initialized: boolean;
}

interface DAGStoreActions {
  /** 初始化 DAG */
  initDAG: (state: DAGVisualizationState) => void;
  /** 更新 DAG 状态 */
  updateDAGStatus: (dagId: string, status: DAGStatus, error?: string) => void;
  /** 更新任务状态 */
  updateTaskStatus: (dagId: string, data: TaskStatusEventData) => void;
  /** 更新任务进度 */
  updateTaskProgress: (dagId: string, data: TaskProgressEventData) => void;
  /** 更新统计信息 */
  updateStatistics: (dagId: string, statistics: DAGStatistics) => void;
  /** 处理 DAG 事件 */
  handleEvent: (event: DAGVisualizationEvent) => void;
  /** 选择 DAG */
  selectDAG: (dagId: string | null) => void;
  /** 显示/隐藏面板 */
  setVisible: (visible: boolean) => void;
  /** 切换面板显示 */
  toggleVisible: () => void;
  /** 获取当前 DAG */
  getCurrentDAG: () => DAGVisualizationState | null;
  /** 获取 DAG */
  getDAG: (dagId: string) => DAGVisualizationState | null;
  /** 移除 DAG */
  removeDAG: (dagId: string) => void;
  /** 清除所有 DAG */
  clearAll: () => void;
}

type DAGStore = DAGStoreState & DAGStoreActions;

// ----------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------

export const useDAGStore = create<DAGStore>((set, get) => ({
  // 初始状态
  dags: new Map(),
  currentDagId: null,
  isVisible: false,
  initialized: false,

  // 初始化 DAG
  initDAG: (state) => {
    logger.info('Initializing DAG:', { dagId: state.dagId });
    set((prev) => {
      const newDags = new Map(prev.dags);
      newDags.set(state.dagId, state);
      return {
        dags: newDags,
        currentDagId: state.dagId,
        isVisible: true,
        initialized: true,
      };
    });
  },

  // 更新 DAG 状态
  updateDAGStatus: (dagId, status, error) => {
    set((prev) => {
      const dag = prev.dags.get(dagId);
      if (!dag) return prev;

      const newDags = new Map(prev.dags);
      newDags.set(dagId, {
        ...dag,
        status,
        error,
        completedAt: ['completed', 'failed', 'cancelled'].includes(status)
          ? Date.now()
          : dag.completedAt,
      });
      return { dags: newDags };
    });
  },

  // 更新任务状态（使用索引优化，O(1) 查找）
  updateTaskStatus: (dagId, data) => {
    set((prev) => {
      const dag = prev.dags.get(dagId);
      if (!dag) return prev;

      // 使用索引快速定位节点（O(1) vs O(n)）
      const index = getDAGIndex(dagId, dag);
      const nodeIndex = index.nodeIndexByTaskId.get(data.taskId);
      if (nodeIndex === undefined) return prev;

      const newNodes = [...dag.nodes];
      const node = newNodes[nodeIndex];
      newNodes[nodeIndex] = {
        ...node,
        data: {
          ...node.data,
          status: data.status,
          output: data.output ?? node.data.output,
          failure: data.failure ?? node.data.failure,
          startedAt: data.startedAt ?? node.data.startedAt,
          completedAt: data.completedAt ?? node.data.completedAt,
          duration: data.duration ?? node.data.duration,
          cost: data.cost ?? node.data.cost,
        },
      };

      // 使用索引只更新相关的边（O(k) vs O(n)，k 是相关边数）
      const newEdges = [...dag.edges];
      const sourceEdgeIndices = index.edgesBySource.get(data.taskId) || [];
      const targetEdgeIndices = index.edgesByTarget.get(data.taskId) || [];

      // 更新出边
      for (const edgeIdx of sourceEdgeIndices) {
        const edge = newEdges[edgeIdx];
        if (data.status === 'running') {
          newEdges[edgeIdx] = { ...edge, data: { ...edge.data, isActive: true } };
        } else if (['completed', 'failed', 'cancelled', 'skipped'].includes(data.status)) {
          newEdges[edgeIdx] = { ...edge, data: { ...edge.data, isActive: false } };
        }
      }

      // 更新入边
      if (data.status === 'running') {
        for (const edgeIdx of targetEdgeIndices) {
          const edge = newEdges[edgeIdx];
          newEdges[edgeIdx] = { ...edge, data: { ...edge.data, isActive: false } };
        }
      }

      const newDags = new Map(prev.dags);
      newDags.set(dagId, { ...dag, nodes: newNodes, edges: newEdges });
      return { dags: newDags };
    });
  },

  // 更新任务进度
  updateTaskProgress: (dagId, data) => {
    set((prev) => {
      const dag = prev.dags.get(dagId);
      if (!dag) return prev;

      const nodeIndex = dag.nodes.findIndex((n) => n.data.taskId === data.taskId);
      if (nodeIndex === -1) return prev;

      const newNodes = [...dag.nodes];
      const node = newNodes[nodeIndex];
      newNodes[nodeIndex] = {
        ...node,
        data: {
          ...node.data,
          iterations: data.iterations ?? node.data.iterations,
          toolsUsed: data.toolsUsed ?? node.data.toolsUsed,
          cost: data.cost ?? node.data.cost,
        },
      };

      const newDags = new Map(prev.dags);
      newDags.set(dagId, { ...dag, nodes: newNodes });
      return { dags: newDags };
    });
  },

  // 更新统计信息
  updateStatistics: (dagId, statistics) => {
    set((prev) => {
      const dag = prev.dags.get(dagId);
      if (!dag) return prev;

      const newDags = new Map(prev.dags);
      newDags.set(dagId, { ...dag, statistics });
      return { dags: newDags };
    });
  },

  // 处理事件
  handleEvent: (event) => {
    const { type, dagId, data } = event;
    const actions = get();

    switch (type) {
      case 'dag:init':
        if ('state' in data) {
          actions.initDAG(data.state);
        }
        break;

      case 'dag:start':
        actions.updateDAGStatus(dagId, 'running');
        break;

      case 'dag:complete':
        actions.updateDAGStatus(dagId, 'completed');
        if ('statistics' in data && data.statistics) {
          actions.updateStatistics(dagId, data.statistics);
        }
        break;

      case 'dag:failed':
        if ('error' in data) {
          actions.updateDAGStatus(dagId, 'failed', data.error);
        }
        break;

      case 'dag:cancelled':
        actions.updateDAGStatus(dagId, 'cancelled');
        break;

      case 'task:status':
        if ('taskId' in data) {
          actions.updateTaskStatus(dagId, data as TaskStatusEventData);
        }
        break;

      case 'task:progress':
        if ('taskId' in data) {
          actions.updateTaskProgress(dagId, data as TaskProgressEventData);
        }
        break;

      case 'statistics:update':
        if ('statistics' in data && data.statistics) {
          actions.updateStatistics(dagId, data.statistics);
        }
        break;

      default:
        logger.warn('Unknown DAG event type:', type);
    }
  },

  // 选择 DAG
  selectDAG: (dagId) => {
    set({ currentDagId: dagId });
  },

  // 显示/隐藏面板
  setVisible: (visible) => {
    set({ isVisible: visible });
  },

  // 切换面板显示
  toggleVisible: () => {
    set((prev) => ({ isVisible: !prev.isVisible }));
  },

  // 获取当前 DAG
  getCurrentDAG: () => {
    const { currentDagId, dags } = get();
    if (!currentDagId) return null;
    return dags.get(currentDagId) ?? null;
  },

  // 获取 DAG
  getDAG: (dagId) => {
    return get().dags.get(dagId) ?? null;
  },

  // 移除 DAG
  removeDAG: (dagId) => {
    set((prev) => {
      const newDags = new Map(prev.dags);
      newDags.delete(dagId);
      return {
        dags: newDags,
        currentDagId: prev.currentDagId === dagId ? null : prev.currentDagId,
      };
    });
  },

  // 清除所有 DAG
  clearAll: () => {
    set({
      dags: new Map(),
      currentDagId: null,
      isVisible: false,
    });
  },
}));

// ----------------------------------------------------------------------------
// Selectors
// ----------------------------------------------------------------------------

/**
 * 获取所有 DAG 列表
 * 使用 useShallow 避免不必要的重渲染
 */
export const useDAGList = (): DAGVisualizationState[] => {
  return useDAGStore(useShallow((state) => Array.from(state.dags.values())));
};

/**
 * 获取当前 DAG
 */
export const useCurrentDAG = () => {
  return useDAGStore((state) => {
    if (!state.currentDagId) return null;
    return state.dags.get(state.currentDagId) ?? null;
  });
};

/**
 * 获取 DAG 可见性
 */
export const useDAGVisible = () => {
  return useDAGStore((state) => state.isVisible);
};

/**
 * 获取活跃的 DAG 数量
 */
export const useActiveDAGCount = () => {
  return useDAGStore((state) => {
    let count = 0;
    state.dags.forEach((dag) => {
      if (dag.status === 'running') count++;
    });
    return count;
  });
};

export default useDAGStore;
