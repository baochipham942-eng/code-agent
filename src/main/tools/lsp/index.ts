// ============================================================================
// LSP Tools - Language Server Protocol Tools
// ============================================================================
// diagnosticsTool 已迁移到 src/main/tools/modules/lsp/diagnostics.ts (native)。
// lspTool 仍是 legacy（待下一个 commit 迁）。
// diagnosticsHelper 是被 file/edit/multiEdit/write 共用的 post-edit hook，保留。
// ============================================================================

export { lspTool } from './lsp';
export { getPostEditDiagnostics } from './diagnosticsHelper';
export type { DiagnosticsResult } from './diagnosticsHelper';
