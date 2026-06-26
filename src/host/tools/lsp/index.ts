// ============================================================================
// LSP Tools — shared post-edit diagnostics helper only
// ============================================================================
// Legacy lsp / diagnostics Tool 实现已迁移到 src/host/tools/modules/lsp/
// （Wave 1, refactor/wave1-lsp-native）。此目录保留 diagnosticsHelper：
// 它不是 legacy Tool，是被 file/edit、file/multiEdit、file/write 共用的
// post-edit 诊断 hook（fs.readFile + manager.notifyFileChanged + 格式化）。
// ============================================================================

export { getPostEditDiagnostics } from './diagnosticsHelper';
export type { DiagnosticsResult } from './diagnosticsHelper';
