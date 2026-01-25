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

// V2 Bootstrap (DI Container based) - 实验性
export {
  initializeCoreServices as initializeCoreServicesV2,
  initializeBackgroundServices as initializeBackgroundServicesV2,
  shutdownServices as shutdownServicesV2,
  getConfigServiceInstance as getConfigServiceInstanceV2,
  getAgentOrchestrator as getAgentOrchestratorV2,
  getGenerationManagerInstance as getGenerationManagerInstanceV2,
  getCurrentSessionId as getCurrentSessionIdV2,
  setCurrentSessionId as setCurrentSessionIdV2,
  getPlanningServiceInstance as getPlanningServiceInstanceV2,
  getTaskManagerInstance as getTaskManagerInstanceV2,
} from './bootstrapV2';
