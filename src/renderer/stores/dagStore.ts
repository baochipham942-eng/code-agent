// ============================================================================
// DAG Store - DAG 可视化状态管理
// Session 5: React Flow 可视化
// ============================================================================

import { create } from 'zustand';
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

  // 更新任务状态
  updateTaskStatus: (dagId, data) => {
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
          status: data.status,
          output: data.output ?? node.data.output,
          failure: data.failure ?? node.data.failure,
          startedAt: data.startedAt ?? node.data.startedAt,
          completedAt: data.completedAt ?? node.data.completedAt,
          duration: data.duration ?? node.data.duration,
          cost: data.cost ?? node.data.cost,
        },
      };

      // 更新边的激活状态
      const newEdges = dag.edges.map((edge) => {
        // 如果源节点刚开始运行，激活出边
        if (edge.source === data.taskId && data.status === 'running') {
          return { ...edge, data: { ...edge.data, isActive: true } };
        }
        // 如果目标节点开始运行，取消入边激活
        if (edge.target === data.taskId && data.status === 'running') {
          return { ...edge, data: { ...edge.data, isActive: false } };
        }
        // 如果源节点完成，取消出边激活
        if (
          edge.source === data.taskId &&
          ['completed', 'failed', 'cancelled', 'skipped'].includes(data.status)
        ) {
          return { ...edge, data: { ...edge.data, isActive: false } };
        }
        return edge;
      });

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
 */
export const useDAGList = () => {
  return useDAGStore((state) => Array.from(state.dags.values()));
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
