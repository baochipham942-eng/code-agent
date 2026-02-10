// ============================================================================
// LSP Diagnostics Helper - Post-edit diagnostics integration
// ============================================================================

import * as fs from 'fs/promises';
import { getLSPManager, type LSPDiagnostic } from '../../lsp';
import { createLogger } from '../../services/infra/logger';
import { getEventBus } from '../../events';

const logger = createLogger('DiagnosticsHelper');

export interface DiagnosticsResult {
  /** 追加到工具 output 的格式化文本 */
  formatted: string;
  /** 原始诊断数据 */
  diagnostics: LSPDiagnostic[];
  /** 错误数 */
  errorCount: number;
  /** 警告数 */
  warningCount: number;
}

/**
 * 获取文件编辑后的 LSP 诊断
 *
 * 流程：
 * 1. 获取 LSP Manager
 * 2. 检查对应文件的 LSP server 是否可用
 * 3. 读取文件内容 → 发送 didChange 通知
 * 4. 等待诊断结果
 * 5. 过滤 severity 1 (Error) 和 2 (Warning)
 * 6. 格式化输出
 *
 * 失败时返回 null（不影响编辑结果）
 */
export async function getPostEditDiagnostics(
  filePath: string,
  timeoutMs = 300
): Promise<DiagnosticsResult | null> {
  try {
    const manager = getLSPManager();
    if (!manager) return null;

    const server = manager.getServerForFile(filePath);
    if (!server || server.getState() !== 'ready') return null;

    // 读取编辑后的文件内容
    const content = await fs.readFile(filePath, 'utf-8');

    // 通知 LSP server 文件已变更
    await manager.notifyFileChanged(filePath, content);

    // 等待诊断结果
    const diagnostics = await manager.waitForDiagnostics(filePath, timeoutMs);

    // 仅保留 Error (1) 和 Warning (2)
    const filtered = diagnostics.filter(
      (d) => d.severity === 1 || d.severity === 2
    );

    if (filtered.length === 0) return null;

    const errorCount = filtered.filter((d) => d.severity === 1).length;
    const warningCount = filtered.filter((d) => d.severity === 2).length;

    // 格式化输出
    const parts: string[] = [];
    const summary: string[] = [];
    if (errorCount > 0) summary.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
    if (warningCount > 0) summary.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`);

    parts.push(`\n\n--- LSP Diagnostics (${summary.join(', ')}) ---`);

    for (const d of filtered) {
      const severity = d.severity === 1 ? 'Error' : 'Warning';
      const line = d.range.start.line + 1;
      const char = d.range.start.character + 1;
      const source = d.source ? ` [${d.source}]` : '';
      parts.push(`${severity} L${line}:${char}: ${d.message}${source}`);
    }

    const result: DiagnosticsResult = {
      formatted: parts.join('\n'),
      diagnostics: filtered,
      errorCount,
      warningCount,
    };

    // 发布诊断事件到 EventBus
    try {
      const bus = getEventBus();
      bus.publish('lsp', 'diagnostics', {
        filePath,
        diagnostics: filtered,
        errorCount,
        warningCount,
      });
    } catch {
      // EventBus 未初始化时忽略
    }

    return result;
  } catch (err) {
    logger.debug('Post-edit diagnostics failed (non-blocking):', err);
    return null;
  }
}
