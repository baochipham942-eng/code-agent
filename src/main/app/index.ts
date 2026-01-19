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
} from './bootstrap';

export {
  cleanup,
  setupLifecycleHandlers,
} from './lifecycle';
