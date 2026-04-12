// ============================================================================
// Tool Search Module - 兼容层（service & 常量已迁至 services/toolSearch）
// ============================================================================
// 本 barrel 仅保留 toolSearchTool 的导出，service/常量请从 services/toolSearch 引入。
// 本文件将在 P0-6 step 2 删除 legacy ToolRegistry 时一并清理。

export { toolSearchTool } from './toolSearch';
export {
  ToolSearchService,
  getToolSearchService,
  resetToolSearchService,
} from '../../services/toolSearch/toolSearchService';
export {
  CORE_TOOLS,
  DEFERRED_TOOLS_META,
  buildDeferredToolIndex,
  isCoreToolName,
} from '../../services/toolSearch/deferredTools';
