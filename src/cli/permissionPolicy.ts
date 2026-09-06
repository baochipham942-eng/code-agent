// ============================================================================
// CLI Permission Policy — 非交互模式的安全默认（借鉴 MiMoCode run 命令设计）
// ============================================================================
//
// CLI run/batch 没有审批 UI，无法人工确认。凡是已经进入 requestPermission 的操作
// 都在等人批准；没有真实批准动作时必须拒绝，不能以布尔 true 冒充用户响应。
// `--dangerously-skip-permissions` 是显式逃生门，恢复全自动批准。
// `--permission-mode auto`（chat/TTY 默认）是中间档（参考 Codex CLI granular approval）：
// 走到审批处理器的请求再经 permissionClassifier 裁决一次——分类器判 approve
// （只读工具 / 工作区内写入 / 安全命令）才放行，并以 approvalSource='cli-auto-approve'
// 自报机器批准来源入账；ask/deny、forceConfirm 与硬门（exec-policy always_confirm、
// skill 边界、GuardFabric、命令解析失败等）一律 fail-closed 拒绝。

import type { PermissionRequestData } from '../host/tools/types';
import type { PermissionAskResult } from '../shared/contract/permission';
import type { DecisionTrace } from '../shared/contract/decisionTrace';
import { classifyPermission } from '../host/tools/permissionClassifier';
import { resolveBackgroundWorkspaceAuthority } from '../host/runtime/workspaceAuthority';

/** CLI 侧颗粒度权限档。chat/TTY 默认 auto；ask 恢复「每条都弹卡」。 */
export type CLIPermissionMode = 'auto' | 'ask';

export interface CLIPermissionPolicyOptions {
  /** 显式逃生门：恢复全自动批准（含危险操作） */
  dangerouslySkipPermissions?: boolean;
  /** 颗粒度权限档：'auto' = 分类器判安全的自动批准并入账，其余 fail-closed 拒绝 */
  permissionMode?: CLIPermissionMode;
  /** auto 模式分类上下文的工作目录（默认 process.cwd()，与 ToolExecutor 基座一致） */
  workingDirectory?: string;
  /** 拒绝时的告警输出（默认 console.error，避免污染 stdout 的 JSON 输出） */
  warn?: (message: string) => void;
}

/**
 * 解析并校验 --permission-mode 标志。非法值或与 --dangerously-skip-permissions
 * 同用时抛错（由命令层转成干净的 CLI 报错退出）。
 */
export function resolveCLIPermissionModeFlag(
  raw: string | undefined,
  dangerouslySkipPermissions?: boolean,
): CLIPermissionMode | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'auto' && raw !== 'ask') {
    throw new Error(`--permission-mode 仅支持 "auto" 或 "ask"（收到: "${raw}"）。`);
  }
  if (raw === 'auto' && dangerouslySkipPermissions) {
    throw new Error(
      '--permission-mode auto 与 --dangerously-skip-permissions 互斥：'
      + 'auto 是分类器裁决的中间档（安全类自动批准、其余 fail-closed 拒绝），'
      + 'skip 是全量放行（含危险操作），二者语义冲突，请只保留一个。',
    );
  }
  return raw;
}

/** requestPermission 代表一个等待人工回答的 ask；CLI/web headless 无法回答。 */
export function requiresHumanConfirmation(_request: PermissionRequestData): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// 交互审批注册点（P4）：Ink TUI 启动时注册审批卡实现，退出时注销。
// headless（非 TTY / 管道 / web）永远注册不到，维持 no-approval-ui fail-closed。
// ---------------------------------------------------------------------------

export type InteractiveApprovalProvider = (request: PermissionRequestData) => Promise<PermissionAskResult>;

let interactiveApprovalProvider: InteractiveApprovalProvider | null = null;

export function setInteractiveApprovalProvider(provider: InteractiveApprovalProvider | null): void {
  interactiveApprovalProvider = provider;
}

export function createCLIPermissionHandler(
  options: CLIPermissionPolicyOptions = {},
): (request: PermissionRequestData) => Promise<PermissionAskResult> {
  const warn = options.warn ?? ((message: string) => console.error(message));

  return async (request: PermissionRequestData): Promise<PermissionAskResult> => {
    if (options.dangerouslySkipPermissions) {
      return { approved: true, approvalSource: 'skip-permissions' };
    }
    const provider = interactiveApprovalProvider;
    if (options.permissionMode === 'auto') {
      const autoResult = await decideAutoMode(request, options);
      if (autoResult.approved) return autoResult;
      // TTY：分类器没放行的再交给审批卡；headless 没有人可问，沿用 fail-closed。
      if (provider) return provider(request);
      warn(autoResult.message ?? `[permission] --permission-mode auto 拒绝: ${request.tool}`);
      return autoResult;
    }
    if (provider) {
      return provider(request);
    }
    if (requiresHumanConfirmation(request)) {
      const target = String(
        request.details?.command || request.details?.path || request.details?.url || request.tool,
      );
      warn(
        `[permission] 非交互模式自动拒绝需人工确认的操作: ${request.tool} (${target})。`
        + ' CLI 无交互确认能力，重试结果相同；'
        + '请改用 GUI/交互模式，或加 --dangerously-skip-permissions（危险）放行。',
      );
      // 拒的是这条路的**环境**（没有审批 UI），不是用户——账本/模型文案都不许再写成 user。
      return { approved: false, denialSource: 'no-approval-ui' };
    }
    return { approved: true, approvalSource: 'noninteractive' };
  };
}

// ---------------------------------------------------------------------------
// --permission-mode auto：分类器裁决的中间档
// ---------------------------------------------------------------------------

/**
 * 这些 ask 来自刻意绕过/压过 classifier 的硬门，auto 模式不得替它们放行：
 * - forceConfirm：信任边界（W3 写边界）/ readOnly 档 / GuardFabric / 确认门控标记的
 *   必须人工确认；
 * - decisionTrace 硬门步骤：tools.always_confirm（policy_enforcer）、GuardFabric、
 *   plugin hook、skill 允许工具边界、命令解析失败、shell 驱动桌面 GUI。
 * 它们到达 requestPermission 时分类器根本没机会判（或已判被压），handler 再跑
 * 一次分类器会得到「更宽」的结果——那正是必须堵住的扩权口。
 */
const AUTO_MODE_HARD_GATE_LAYERS = new Set(['policy_enforcer', 'guard_fabric', 'plugin_hook']);
const AUTO_MODE_HARD_GATE_RULES = new Set([
  'command_analysis_failed',
  'skill.allowed-tools-boundary',
  'shell_desktop_automation',
]);

function findAutoModeHardGate(trace: DecisionTrace | undefined): string | null {
  if (!trace) return null;
  for (const step of trace.steps) {
    if (AUTO_MODE_HARD_GATE_LAYERS.has(step.layer) || AUTO_MODE_HARD_GATE_RULES.has(step.rule)) {
      return `${step.layer}/${step.rule}`;
    }
  }
  return null;
}

async function decideAutoMode(
  request: PermissionRequestData,
  options: CLIPermissionPolicyOptions,
): Promise<PermissionAskResult> {
  const target = String(
    request.details?.command || request.details?.path || request.details?.url || request.tool,
  );
  const deny = (reason: string): PermissionAskResult => {
    return {
      approved: false,
      denialSource: 'no-approval-ui',
      message:
        `[permission] --permission-mode auto 拒绝: ${request.tool} (${target}) — ${reason}\n`
        + `${request.tool} 未获自动批准（--permission-mode auto）：${reason}。`
        + 'auto 档只放行分类器判定安全的操作（只读工具、工作区/临时目录内写入、安全命令），'
        + '其余一律 fail-closed 拒绝——重试结果相同，不要重试。'
        + '出路：改用有审批界面的交互模式（GUI），或显式加 --dangerously-skip-permissions 重跑（危险）。',
    };
  };

  if (request.forceConfirm) {
    return deny('该操作被标记为必须人工确认（forceConfirm），auto 档不放行');
  }
  const hardGate = findAutoModeHardGate(request.decisionTrace);
  if (hardGate) {
    return deny(`命中硬性审批门（${hardGate}），auto 档不放行`);
  }

  try {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    // 与 ToolExecutor.writeWorkspaceRoot 同一份宽度校验：$HOME / 数据目录 / 祖先路径
    // 不会变成 auto 档的写边界。
    const workspaceRoot = resolveBackgroundWorkspaceAuthority({ workspace: workingDirectory })?.primaryRoot;
    const classification = await classifyPermission(request.tool, request.details ?? {}, {
      workingDirectory,
      workspaceRoot,
    });
    // trustBoundary 的 approve 理论上不存在（边界决策都是 ask），仍显式让路防回归。
    if (classification.decision === 'approve' && !classification.trustBoundary) {
      // 机器批准必须自报来源：toolExecutor 会把 approvalSource 写进 decision trace
      // 与权限账本（ask-approved / 审批放行（来源：cli-auto-approve）），且不会触发
      // exec-policy 的 learnFromApproval（仅真人批准才学习）。
      return { approved: true, approvalSource: 'cli-auto-approve' };
    }
    return deny(`分类器判定不可自动批准（${classification.decision}）：${classification.reason}`);
  } catch (error) {
    // 分类器抛错 ≠ 判 ask：故障一律 fail-closed。
    return deny(`分类器故障，按安全侧默认拒绝：${error instanceof Error ? error.message : String(error)}`);
  }
}
