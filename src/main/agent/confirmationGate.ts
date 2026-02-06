// ============================================================================
// Confirmation Gate - 细粒度确认门控
// ============================================================================
//
// 写操作前展示 before/after 预览 + 确认对话框，策略可配置。
// 复用现有 requestPermission 回调，扩展 PermissionRequest 类型。

import * as Diff from 'diff';
import { createLogger } from '../services/infra/logger';
import type {
  ConfirmationPolicy,
  ConfirmationPreview,
  ConfirmationContext,
  ToolConfirmationConfig,
} from '../../shared/types/confirmation';

const logger = createLogger('ConfirmationGate');

// 危险工具列表
const DANGEROUS_TOOLS = new Set([
  'bash',
  'write_file',
  'edit_file',
]);

// 高风险 bash 命令模式
const HIGH_RISK_PATTERNS = [
  /rm\s+(-r|-rf|-f)/,
  /git\s+(push|reset|rebase|merge)/,
  /sudo\s/,
  /chmod\s/,
  /chown\s/,
  /mv\s.*\//,
  />\s*\//,
  /npm\s+(publish|deprecate)/,
  /docker\s+(rm|rmi|stop|kill)/,
];

const DEFAULT_CONFIG: ToolConfirmationConfig = {
  policy: 'ask_if_dangerous',
  overrides: {},
};

export class ConfirmationGate {
  private config: ToolConfirmationConfig;
  /** sessionId -> Set<toolNameOrPattern> */
  private sessionApprovals = new Map<string, Set<string>>();

  constructor(config?: Partial<ToolConfirmationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 判断是否需要确认
   */
  shouldConfirm(context: ConfirmationContext, sessionId: string): boolean {
    const { toolName } = context;

    // 获取该工具的策略
    const policy = this.config.overrides?.[toolName] || this.config.policy;

    switch (policy) {
      case 'always_approve':
        return false;

      case 'always_ask':
        return true;

      case 'session_approve': {
        const approved = this.sessionApprovals.get(sessionId);
        if (approved?.has(toolName)) {
          return false;
        }
        return true;
      }

      case 'ask_if_dangerous':
      default:
        return context.riskLevel === 'high';
    }
  }

  /**
   * 为工具调用构建预览信息
   */
  buildPreview(toolName: string, params: Record<string, unknown>): ConfirmationPreview | undefined {
    switch (toolName) {
      case 'edit_file': {
        const oldStr = params.old_string as string | undefined;
        const newStr = params.new_string as string | undefined;
        const filePath = (params.file_path || params.path) as string | undefined;

        if (oldStr && newStr) {
          const diff = Diff.createPatch(
            filePath || 'file',
            oldStr,
            newStr,
            'before',
            'after'
          );
          return {
            type: 'diff',
            before: oldStr.substring(0, 500),
            after: newStr.substring(0, 500),
            diff,
            summary: `编辑文件 ${filePath || '(unknown)'}`,
          };
        }
        return {
          type: 'generic',
          summary: `编辑文件 ${filePath || '(unknown)'}`,
        };
      }

      case 'write_file': {
        const filePath = (params.file_path || params.path) as string | undefined;
        const content = params.content as string | undefined;
        return {
          type: 'diff',
          after: content?.substring(0, 500),
          summary: `写入文件 ${filePath || '(unknown)'} (${content?.length || 0} 字符)`,
        };
      }

      case 'bash': {
        const command = params.command as string | undefined;
        return {
          type: 'command',
          summary: command?.substring(0, 200) || '(empty command)',
        };
      }

      default:
        return {
          type: 'generic',
          summary: `执行工具 ${toolName}`,
        };
    }
  }

  /**
   * 评估工具调用的风险级别
   */
  assessRiskLevel(toolName: string, params: Record<string, unknown>): 'low' | 'medium' | 'high' {
    if (!DANGEROUS_TOOLS.has(toolName)) {
      return 'low';
    }

    if (toolName === 'bash') {
      const command = (params.command as string) || '';
      if (HIGH_RISK_PATTERNS.some(p => p.test(command))) {
        return 'high';
      }
      return 'medium';
    }

    if (toolName === 'write_file') {
      return 'medium';
    }

    if (toolName === 'edit_file') {
      return 'low';
    }

    return 'low';
  }

  /**
   * 记录用户批准
   */
  recordApproval(sessionId: string, toolName: string): void {
    if (!this.sessionApprovals.has(sessionId)) {
      this.sessionApprovals.set(sessionId, new Set());
    }
    this.sessionApprovals.get(sessionId)!.add(toolName);
  }

  /**
   * 清除 session 的批准记录
   */
  clearSessionApprovals(sessionId: string): void {
    this.sessionApprovals.delete(sessionId);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ToolConfirmationConfig>): void {
    Object.assign(this.config, config);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: ConfirmationGate | null = null;

export function getConfirmationGate(config?: Partial<ToolConfirmationConfig>): ConfirmationGate {
  if (!instance) {
    instance = new ConfirmationGate(config);
  }
  return instance;
}

export function resetConfirmationGate(): void {
  instance = null;
}
