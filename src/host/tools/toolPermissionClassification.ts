// ============================================================================
// 工具权限分类解析（从 toolExecutor.execute 收拢，god-file debt 门：>1000 有效行）
// ============================================================================

import { classifyPermission, type ClassificationResult } from './permissionClassifier';
import { isExternalSideEffectTool } from './externalSideEffect';
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
 * 只读探索档（审出 MED）：无审批 UI 的运行环境（CLI run/batch 非交互模式，见
 * `src/cli/permissionPolicy.ts` 的 createCLIPermissionHandler）对 forceConfirm 请求
 * 自动拒绝（fail-closed）。泛用的 "Permission denied by user" 在该路径是误导——
 * 给模型可转述的真实原因与出路。
 *
 * D4 通话态钳档（2026-07-26 真机实录）：live-voice 会话被钳到 readOnly 时也会走
 * 这条 forceConfirm 拒绝路径，但它**不是无 UI 环境**——agentOrchestrator.requestPermission
 * 对通话态一律走「停车挂起」（parkApproval），请求真的进了审批卡等用户应答，只是不在
 * 60s 内强求。上面这句「无审批界面会自动拒绝」+「请切换会话权限档」在这里两句都是假话：
 * 档是通话钳的不是用户设的，切换也没用（钳制只收紧不放宽）。isLiveVoiceClamp=true 时
 * 换成如实描述通话场景的文案，不复用无 UI 那句。
 */
export function readOnlyDenialError(toolName: string, isLiveVoiceClamp: boolean): string {
  if (isLiveVoiceClamp) {
    return `实时语音通话中：${toolName} 需要写入/执行权限，已挂起等待你在审批卡上确认，但这次请求最终没有获批（你选择了拒绝，或超时未处理）。通话期间无法通过切换会话权限档跳过这一步——如需执行，请重新发起请求并在审批卡上点允许。`;
  }
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
  // B1: EXTERNAL 风险类打标，与三分支决策正交、不改变审批结果。所有出口都带上，供 B2/B4/审计消费。
  const external = isExternalSideEffectTool(input.executionToolName);
  if (input.policyForcesConfirmation) {
    return {
      decision: 'ask',
      reason: `Tool "${input.executionToolName}" requires confirmation by policy (tools.always_confirm)`,
      confidence: 1,
      cached: false,
      external,
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
      external,
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
  return { ...classification, external };
}
