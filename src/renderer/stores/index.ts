// ============================================================================
// Stores - Unified Export
// Session 7: Store 重构
// ============================================================================

// -----------------------------------------------------------------------------
// Core Stores
// -----------------------------------------------------------------------------

export { useAppStore, type DisclosureLevel, type SettingsTab } from './appStore';
export { useUIStore, useToast, useModal, useConfirm, useDeepResearch } from './uiStore';
export type {
  ModalType,
  ToastType,
  Toast,
  ConfirmOptions,
  ResearchPhase,
  ReportStyle,
  ResearchProgress,
  DeepResearchState,
} from './uiStore';

export {
  useSessionStore,
  initializeSessionStore,
  type SessionWithMeta,
  type SessionFilter,
} from './sessionStore';

export { useAuthStore, initializeAuthStore } from './authStore';

// -----------------------------------------------------------------------------
// Feature Stores
// -----------------------------------------------------------------------------

export { useDAGStore, useDAGList, useCurrentDAG, useDAGVisible, useActiveDAGCount } from './dagStore';
export { useModeStore, useIsDeveloperMode, useIsCoworkMode, type AppMode } from './modeStore';
export {
  usePermissionStore,
  type PermissionType,
  type ApprovalLevel,
  type PermissionRequestForMemory,
} from './permissionStore';
export { useSkillStore } from './skillStore';
export { useStatusStore, type NetworkStatus } from './statusStore';
export {
  useTaskStore,
  getStatusLabel,
  getStatusColor,
  type SessionStatus,
  type SessionState as TaskSessionState,
  type TaskStats,
} from './taskStore';
export { useSwarmStore } from './swarmStore';
export { useTelemetryStore } from './telemetryStore';

// -----------------------------------------------------------------------------
// Selectors - 优化渲染性能
// -----------------------------------------------------------------------------

import { useAppStore } from './appStore';
import { useSessionStore, initializeSessionStore as _initSessionStore } from './sessionStore';
import { useStatusStore } from './statusStore';
import { useTaskStore } from './taskStore';
import { initializeAuthStore as _initAuthStore } from './authStore';
import { useShallow } from 'zustand/shallow';

/**
 * 获取当前会话 ID
 * 使用 shallow 比较避免不必要的重渲染
 */
export function useCurrentSessionId(): string | null {
  return useSessionStore((state) => state.currentSessionId);
}

/**
 * 获取当前会话的消息列表
 */
export function useCurrentMessages() {
  return useSessionStore((state) => state.messages);
}

/**
 * 获取当前会话的待办列表
 */
export function useCurrentTodos() {
  return useSessionStore((state) => state.todos);
}

/**
 * 获取会话列表
 */
export function useSessions() {
  return useSessionStore((state) => state.sessions);
}

/**
 * 获取会话加载状态
 */
export function useSessionLoading() {
  return useSessionStore((state) => state.isLoading);
}

/**
 * 检查指定会话是否正在运行
 */
export function useIsSessionRunning(sessionId: string): boolean {
  return useSessionStore((state) => state.runningSessionIds.has(sessionId));
}

/**
 * 获取运行中的会话数量
 */
export function useRunningSessionCount(): number {
  return useSessionStore((state) => state.runningSessionIds.size);
}

/**
 * 获取当前代际信息
 */
export function useCurrentGeneration() {
  return useAppStore((state) => state.currentGeneration);
}

/**
 * 获取模型配置
 */
export function useModelConfig() {
  return useAppStore((state) => state.modelConfig);
}

/**
 * 获取工作目录
 */
export function useWorkingDirectory() {
  return useAppStore((state) => state.workingDirectory);
}

/**
 * 获取处理状态 (全局)
 */
export function useIsProcessing() {
  return useAppStore((state) => state.isProcessing);
}

/**
 * 获取语言设置
 */
export function useLanguage() {
  return useAppStore((state) => state.language);
}

/**
 * 获取状态栏信息
 * 使用 useShallow 比较组合多个字段
 */
export function useStatusBarInfo() {
  return useStatusStore(
    useShallow((state) => ({
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      sessionCost: state.sessionCost,
      contextUsagePercent: state.contextUsagePercent,
      networkStatus: state.networkStatus,
      gitBranch: state.gitBranch,
    }))
  );
}

/**
 * 获取任务统计信息
 */
export function useTaskStats() {
  return useTaskStore((state) => state.stats);
}

/**
 * 获取指定会话的任务状态
 */
export function useSessionTaskState(sessionId: string) {
  return useTaskStore((state) => state.sessionStates[sessionId] || { status: 'idle' });
}

// -----------------------------------------------------------------------------
// Combined Selectors - 跨 store 数据组合
// -----------------------------------------------------------------------------

/**
 * 获取当前会话的完整上下文
 * 组合 sessionStore 和 appStore 的相关数据
 */
export function useSessionContext() {
  const sessionId = useCurrentSessionId();
  const messages = useCurrentMessages();
  const todos = useCurrentTodos();
  const generation = useCurrentGeneration();
  const workingDirectory = useWorkingDirectory();

  return {
    sessionId,
    messages,
    todos,
    generation,
    workingDirectory,
  };
}

/**
 * 获取应用全局状态概要
 */
export function useAppSummary() {
  const sessions = useSessions();
  const runningCount = useRunningSessionCount();
  const taskStats = useTaskStats();
  const statusBar = useStatusBarInfo();

  return {
    totalSessions: sessions.length,
    runningCount,
    taskStats,
    statusBar,
  };
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

/**
 * 初始化所有 stores
 * 在应用启动时调用
 */
export async function initializeStores(): Promise<void> {
  // 按依赖顺序初始化
  await _initAuthStore();
  await _initSessionStore();
}
