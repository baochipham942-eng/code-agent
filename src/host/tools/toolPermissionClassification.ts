// ============================================================================
// 工具权限分类解析（从 toolExecutor.execute 收拢，god-file debt 门：>1000 有效行）
// ============================================================================

import { classifyPermission, type ClassificationResult } from './permissionClassifier';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { getPermissionModeManager, permissionModeAutoApproves, type PermissionMode } from '../permissions/modes';

type ToolPermissionLevel = Parameters<typeof permissionModeAutoApproves>[1];

interface PermissionedToolShape {
  requiresPermission: boolean;
  permissionLevel: ToolPermissionLevel;
  readOnly?: boolean;
}

/**
 * 会话有效权限档：subagent 走父子收缩后的 override（禁止回读父会话档扩权），
 * 主 agent 走会话档单一真源。
 */
export function resolveSessionPermissionMode(
  override: PermissionMode | undefined,
  sessionId?: string,
): PermissionMode {
  return override ?? getPermissionModeManager().getModeForSession(sessionId);
}

/**
 * B1 第 4 档「只读探索」（readOnly）：读/列/搜类工具直通，写文件和执行命令
 * 一律走用户确认——预授权 / 安全命令白名单 / lenient / classifier 自动放行全部失效。
 * network 档（审出 HIGH）：只读联网（webSearch/webFetch、显式 readOnlyHint 的 MCP）
 * 保持直通；未声明只读的 network 工具（httpRequest/jira、无 annotations 的 MCP 兜底）
 * 视同变更类，readOnly 下与写入/执行同等强制确认。
 */
export function readOnlyForcesConfirmationFor(
  mode: PermissionMode,
  toolDef: PermissionedToolShape,
): boolean {
  return toolDef.requiresPermission
    && mode === 'readOnly'
    && (toolDef.permissionLevel === 'write'
      || toolDef.permissionLevel === 'execute'
      || (toolDef.permissionLevel === 'network' && toolDef.readOnly !== true));
}

/**
 * 只读探索档（审出 MED）：无审批 UI 的运行环境（web 聊天 /api/agent/run 走
 * CLI 非交互 handler、CLI run/batch）对 forceConfirm 请求自动拒绝（fail-closed）。
 * 泛用的 "Permission denied by user" 在该路径是误导——给模型可转述的真实原因与出路。
 */
export function readOnlyDenialError(toolName: string): string {
  return `只读探索模式：${toolName} 未获用户确认而被拦截（无审批界面的运行环境会自动拒绝）。如需执行该操作，请切换会话权限档后重试。`;
}

/**
 * 权限分类三分支解析 + 档位改写：
 * 1. policy always_confirm / skill 边界违规 → 直接 ask（跳过 classifier）；
 * 2. 其余走 classifier；
 * 3. readOnly 档把 classifier 的 approve 降级为 ask（deny 保持原判，危险命令不弱化）；
 * 4. B1 档位免确认（审出 MED：bypass/acceptEdits 曾在主判定链零消费、纯虚标）：
 *    bypassPermissions=写入+执行免确认，acceptEdits=仅写入免确认——只把 ask 升级为
 *    approve，deny / exec-policy forbidden / policy always_confirm / skill 边界 /
 *    前置 validateCommand 硬毙全部照常生效。
 */
export async function resolveToolPermissionClassification(input: {
  executionToolName: string;
  policyToolName: string;
  params: Parameters<typeof classifyPermission>[1];
  policyForcesConfirmation: boolean;
  boundaryViolation: { skillName: string; allowedTools: readonly string[] } | undefined;
  workingDirectory: string;
  workspaceRoot: string;
  permissionLevel: ToolPermissionLevel;
  permStartTime: number;
  readOnlyForcesConfirmation: boolean;
  sessionPermissionMode: PermissionMode;
}): Promise<ClassificationResult> {
  if (input.policyForcesConfirmation) {
    return {
      decision: 'ask',
      reason: `Tool "${input.executionToolName}" requires confirmation by policy (tools.always_confirm)`,
      confidence: 1,
      cached: false,
      traceStep: createTraceStep(
        'policy_enforcer',
        'tools.always_confirm',
        'ask',
        'Tool requires confirmation by policy',
        input.permStartTime,
      ),
    };
  }
  if (input.boundaryViolation) {
    return {
      decision: 'ask',
      reason: `Tool "${input.executionToolName}" is outside skill "${input.boundaryViolation.skillName}" allowed-tools boundary (${input.boundaryViolation.allowedTools.join(', ')})`,
      confidence: 1,
      cached: false,
      traceStep: createTraceStep(
        'permission_classifier',
        'skill.allowed-tools-boundary',
        'ask',
        `Outside skill "${input.boundaryViolation.skillName}" tool boundary`,
        input.permStartTime,
      ),
    };
  }
  let classification = await classifyPermission(input.policyToolName, input.params, {
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
    permissionLevel: input.permissionLevel,
  });
  if (input.readOnlyForcesConfirmation && classification.decision === 'approve') {
    const opLabel = input.permissionLevel === 'write' ? '写入'
      : input.permissionLevel === 'network' ? '网络变更'
      : '执行';
    const reason = `只读探索模式：${opLabel}操作需要用户确认`;
    classification = {
      decision: 'ask',
      reason,
      confidence: 1,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'readonly_explore_mode', 'ask', reason, input.permStartTime),
    };
  }
  if (classification.decision === 'ask'
    && permissionModeAutoApproves(input.sessionPermissionMode, input.permissionLevel)) {
    const reason = `权限档 ${input.sessionPermissionMode}：${input.permissionLevel === 'write' ? '写入' : '执行'}操作免确认`;
    classification = {
      decision: 'approve',
      reason,
      confidence: 1,
      cached: false,
      traceStep: createTraceStep('permission_classifier', 'permission_mode_auto_approve', 'allow', reason, input.permStartTime),
    };
  }
  return classification;
}
