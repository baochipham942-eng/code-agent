// ============================================================================
// App Module - 应用核心模块导出
// ============================================================================

export {
  createWindow,
  getMainWindow,
  setMainWindow,
} from './window';

export {
  initializeCoreServices,
  initializeBackgroundServices,
  getConfigServiceInstance,
  getAgentOrchestrator,
  getGenerationManagerInstance,
  getCurrentSessionId,
  setCurrentSessionId,
  getPlanningServiceInstance,
  getTaskManagerInstance,
} from './bootstrap';

export {
  cleanup,
  setupLifecycleHandlers,
} from './lifecycle';
