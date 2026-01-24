// ============================================================================
// Hooks - Index
// ============================================================================

export { useTheme } from './useTheme';
export type { Theme, ResolvedTheme } from './useTheme';
export { useAgent } from './useAgent';
export { useGeneration } from './useGeneration';
export { useRequireAuth } from './useRequireAuth';
export { useCloudTasks, useCloudTask, useCloudTaskStats } from './useCloudTasks';
export { useVoiceInput } from './useVoiceInput';
export type { VoiceInputStatus } from './useVoiceInput';
export { useMultiAgentDetection, useIsParallelExecution, useIsHierarchicalOrchestration, useAgentCount } from './useMultiAgentDetection';
export type { MultiAgentInfo, CollaborationPattern } from './useMultiAgentDetection';
export { useMemoryEvents } from './useMemoryEvents';
export type { MemoryEventCallbacks } from './useMemoryEvents';
export { useMessageBatcher } from './useMessageBatcher';
export type {
  MessageBatcherConfig,
  MessageBatcherReturn,
  MessageUpdate,
} from './useMessageBatcher';
export { useTaskSync, useSessionTaskState, useHasRunningTasks, useTaskConcurrency } from './useTaskSync';
export type { UseTaskSyncOptions, UseTaskSyncReturn } from './useTaskSync';
