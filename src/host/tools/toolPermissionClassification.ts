// ============================================================================
// 工具权限分类解析（从 toolExecutor.execute 收拢，god-file debt 门：>1000 有效行）
// ============================================================================

import { classifyPermission, type ClassificationResult } from './permissionClassifier';
import { isExternalSideEffectTool } from './externalSideEffect';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { getPermissionModeManager, permissionModeAutoApproves, type PermissionMode } from '../permissions/modes';
import type { PermissionDenialSource } from '../../shared/contract/permission';
import {
  getStrictBrowserComputerActionCatalogForArgs,
  normalizeBrowserComputerCatalogToolName,
} from '../../shared/utils/browserComputerActionCatalog';

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
 * 曾经有一条 `isLiveVoiceClamp` 文案分支：通话态被钳到 readOnly 时，「请切换会话权限档」
 * 是假话（档是通话钳的，切了也没用）。**2026-07-29 通话态不再钳档之后这条分支就死了**——
 * 通话中还处在 readOnly 只有一种可能：用户自己选的。那时「切换会话权限档」恰恰是真话，
 * 也是他唯一该听的建议。留着一条永远走不到、且内容已经变假的分支，比没有更糟。
 */
export function readOnlyDenialError(toolName: string): string {
  return `只读探索模式：${toolName} 未获用户确认而被拦截（无审批界面的运行环境会自动拒绝）。如需执行该操作，请切换会话权限档后重试。`;
}

/**
 * 分类器**抛错**（≠ 判 ask）回退人工审批时写进 decisionTrace 的 rule 名。
 * 单独一个常量是为了让「故障回退」与「正常判 ask」在账本里天然可区分。
 */
export const CLASSIFIER_ERROR_TRACE_RULE = 'classifier_error';
const BROWSER_COMPUTER_CONSEQUENCE_TRACE_RULE = 'browser_computer_consequence';
export const BROWSER_COMPUTER_HIGH_RISK_BLOCKED_CODE = 'BROWSER_COMPUTER_HIGH_RISK_BLOCKED';

function classifyBrowserComputerConsequence(
  toolName: string,
  params: Record<string, unknown>,
  startedAt: number,
): ClassificationResult | null {
  const catalogTool = normalizeBrowserComputerCatalogToolName(toolName);
  if (!catalogTool) return null;
  const entry = getStrictBrowserComputerActionCatalogForArgs({
    toolName: catalogTool,
    arguments: params,
  });
  if (!entry) {
    const reason = `Browser/computer action is not registered in the consequence catalog: ${catalogTool}`;
    return {
      decision: 'deny',
      reason,
      confidence: 1,
      cached: false,
      traceStep: createTraceStep(
        'permission_classifier',
        BROWSER_COMPUTER_CONSEQUENCE_TRACE_RULE,
        'deny',
        reason,
        startedAt,
      ),
    };
  }
  if (entry.consequence === 'high_risk') {
    const reason = `High-risk browser/computer action is blocked by policy: ${entry.tool}.${entry.action}`;
    return {
      decision: 'deny',
      reason,
      confidence: 1,
      cached: false,
      errorCode: BROWSER_COMPUTER_HIGH_RISK_BLOCKED_CODE,
      traceStep: createTraceStep(
        'permission_classifier',
        BROWSER_COMPUTER_CONSEQUENCE_TRACE_RULE,
        'deny',
        reason,
        startedAt,
      ),
    };
  }
  const decision = entry.consequence === 'external_side_effect' ? 'ask' : 'approve';
  const reason = decision === 'ask'
    ? `Browser/computer action changes external state and requires confirmation: ${entry.tool}.${entry.action}`
    : `Browser/computer action has no external side effect: ${entry.tool}.${entry.action}`;
  return {
    decision,
    reason,
    confidence: 1,
    cached: false,
    traceStep: createTraceStep(
      'permission_classifier',
      BROWSER_COMPUTER_CONSEQUENCE_TRACE_RULE,
      decision === 'approve' ? 'allow' : 'ask',
      reason,
      startedAt,
    ),
  };
}

/**
 * 拒绝文案的唯一来源。**这段文本有两个受众**：模型（会据此向用户转述）和审计日志。
 * 泛用的 "Permission denied by user" 在机器自动拒的路径上是**假话**——用户什么都没看见，
 * 模型却会告诉他「你拒绝了」。每种 denialSource 必须给出真实原因 + 可执行的出路。
 */
export function permissionDenialError(toolName: string, source: PermissionDenialSource): string {
  switch (source) {
    case 'user':
      return 'Permission denied by user';
    case 'no-approval-ui':
      return `${toolName} 被自动拒绝：当前运行环境没有审批界面（非交互 CLI / web headless），`
        + '需人工确认的操作一律 fail-closed 拒绝——用户并未看到审批请求。'
        + '出路：把会话权限档抬到 bypassPermissions，或改用无需确认的等价操作。';
    case 'timeout':
      return `${toolName} 被自动拒绝：审批请求已发出但超时无人应答。出路：请用户在收件箱/会话卡上处理后重试。`;
    case 'cancelled':
      return `${toolName} 被自动拒绝：本次运行已被取消（或有新消息到达），挂起的审批被统一解除。`;
    case 'fail-closed':
      return `${toolName} 被自动拒绝：审批链路依赖不可用，按安全侧默认拒绝（fail-closed），并非用户拒绝。`;
    case 'scripted':
      return `${toolName} 被评测脚本自动拒绝：当前为 scripted approval eval 模式，并非用户拒绝。`;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
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
  workspaceRoot?: string;
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
  let classification = classifyBrowserComputerConsequence(
    input.executionToolName,
    input.params,
    input.permStartTime,
  ) ?? await classifyPermission(input.policyToolName, input.params, {
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
