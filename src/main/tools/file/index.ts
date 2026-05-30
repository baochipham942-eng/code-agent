// ============================================================================
// File Tools - 文件操作工具
// ============================================================================
// 所有 legacy 文件工具已迁至 modules/file/ 下的 native ToolModule 并删除旧实现。
// 此 barrel 仅保留 pathUtils（仍被 modules/decorated 测试夹具引用）。

// Path utilities
export { expandTilde, resolvePath } from './pathUtils';
