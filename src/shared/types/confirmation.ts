// ============================================================================
// Confirmation Types - 细粒度确认门控共享类型
// ============================================================================

export type ConfirmationPolicy =
  | 'always_ask'       // 每次都确认
  | 'always_approve'   // 自动批准
  | 'ask_if_dangerous' // 仅危险操作确认
  | 'session_approve'; // 会话内首次确认后自动批准

export interface ConfirmationPreview {
  type: 'diff' | 'command' | 'network' | 'generic';
  before?: string;
  after?: string;
  diff?: string;
  summary: string;
}

export interface ConfirmationContext {
  toolName: string;
  params: Record<string, unknown>;
  preview?: ConfirmationPreview;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ToolConfirmationConfig {
  policy: ConfirmationPolicy;
  /** 按工具名覆盖策略 */
  overrides?: Record<string, ConfirmationPolicy>;
}
