import type { ToolDefinition } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import { ASK_USER_QUESTION_TOOL_NAMES } from '../../../shared/constants/tools';
import { createLogger } from '../../services/infra/logger';
import { trackNode } from '../../observability/posthogNode';
import { POSTHOG_EVENTS } from '../../../shared/observability/posthog-events';
// 纯函数真源在 tools/runToolPolicy.ts（ToolExecutor 执行层兜底闸也用同一份语义）；
// 本文件只做 RuntimeContext 包装 + 收窄可观测性。
import {
  isToolDeniedByRunPolicy,
  type RunToolPolicy,
} from '../../tools/runToolPolicy';
import { canonicalStrictBoundaryToolNames } from '../../tools/skillBoundaryScope';
import { detectTaskFeatures } from '../../prompts/systemReminders';

const logger = createLogger('AgentLoop');

const ONE_TURN_DELEGATION_TOOLS = new Set([
  'task',
  'delegate_task',
  'spawn_agent',
  'agentspawn',
  'workflow',
  'workflow_orchestrate',
]);

function latestUserPrompt(ctx: RuntimeContext): string {
  return [...(ctx.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '';
}

// 轮内会再注入 user 角色消息（autoApprovePlan 的合成确认、runtimeSteer 的转向消息），
// 「最新一条 user」会偏离开跑 prompt，所以按轮判定只认 turn.beginRun 记下的起始 prompt。
function currentTurnUserPrompt(ctx: RuntimeContext): string {
  return ctx.turn?.runUserPrompt || latestUserPrompt(ctx);
}

function isBoundedComparisonTurn(ctx: RuntimeContext): boolean {
  return detectTaskFeatures(currentTurnUserPrompt(ctx)).isBoundedComparison === true;
}

/**
 * 委派面收口的两种「单轮可直出」形态（都只判**本轮**的 prompt，不扫会话历史——
 * 扫全量 user 消息会让一次竞品卡轮把同会话之后所有轮的委派面永久收掉，
 * 「跑测试/装依赖/并行调研」再也派不了后台，PR review 2026-10-15）：
 * - 单轮 Office 文件交付（isOneTurnFileDeliverable）——前台没有终端，模型看得见
 *   delegate_task 时只会「写脚本 + 派后台」，后台 terminal_write 撞审批卡死，
 *   整轮以「运行失败」收场（N-HOME-STARTER-CARDS-FILES r2 实测）。收掉委派入口，
 *   工具面上剩下的文件生成路径（docx_generate/excel_generate）就是最短路。
 * - 小范围单轮对比（isBoundedComparison）——「少量实体 + 一轮交付」的调研在文字
 *   前台一轮即可直出；委派倾向模型（glm-5.3 类）看得见 spawn_agent/delegate_task
 *   时会把首轮改道进 swarm，成员启动审批卡可再卡死整轮（2026-10-11 缺陷）。
 */
function isOneTurnDelegationBypassTool(toolName: string, ctx: RuntimeContext): boolean {
  if (!ONE_TURN_DELEGATION_TOOLS.has(toolName.trim().toLowerCase())) return false;
  if (detectTaskFeatures(latestUserPrompt(ctx)).isOneTurnFileDeliverable === true) return true;
  return isBoundedComparisonTurn(ctx);
}

export function isToolDeniedForRun(ctx: RuntimeContext, toolName: string): boolean {
  return isToolDeniedByRunPolicy(runtimeToolPolicy(ctx), toolName);
}

/**
 * RuntimeContext → RunToolPolicy：补上 strict skill 流程面豁免名单。
 * ctx 本身是 RunToolPolicy 形状的历史原因（零依赖叶子模块直接吃 ctx），但 ctx 没有
 * skillBoundaryAllowedTools 字段——这里集中构造，白名单判定与执行层兜底闸用同一份语义。
 */
function runtimeToolPolicy(ctx: RuntimeContext): RunToolPolicy {
  return {
    deniedToolNames: ctx.deniedToolNames,
    allowedToolNames: ctx.allowedToolNames,
    toolScope: ctx.toolScope,
    skillBoundaryAllowedTools: canonicalStrictBoundaryToolNames(ctx.turn?.skillToolBoundary),
  };
}

export function deniedToolRetryGuidance(ctx: RuntimeContext): string {
  // unattendedTurn 时 AskUserQuestion 已被 filterToolsByRunPolicy 收出工具面
  // （issue #1994），重试指引不许再把模型引回这个不可用工具。
  const askDenied = ctx.unattendedTurn === true
    || ASK_USER_QUESTION_TOOL_NAMES.some((name) => isToolDeniedForRun(ctx, name));
  return askDenied
    ? 'Continue without those tools. If you need user input, state the blocker in your final text instead of calling an interactive tool.'
    : 'Continue without those tools. AskUserQuestion remains available; call it directly when the current task requires user input.';
}

export function filterToolsByRunPolicy(
  tools: ToolDefinition[],
  ctx: RuntimeContext,
): ToolDefinition[] {
  // issue #1994：无人值守轮（headless 跑批 / 管道 / cron 等）没有人应答
  // AskUserQuestion——留在工具面只会让模型白问一轮并触发问句未答冻结，整轮作废。
  // 信号复用现有 unattendedTurn（originKind==='headless' / 会话级无人值守标记），
  // 不新造平行判定；有人值守轮原样保留，交互行为不变。
  const askUnattended = ctx.unattendedTurn === true;
  const oneTurnFileDeliverable = detectTaskFeatures(latestUserPrompt(ctx)).isOneTurnFileDeliverable === true;
  const boundedComparison = isBoundedComparisonTurn(ctx);
  const hasPolicy = (ctx.deniedToolNames?.length ?? 0) > 0 || (ctx.allowedToolNames?.length ?? 0) > 0;
  if (!hasPolicy && !askUnattended && !oneTurnFileDeliverable && !boundedComparison) return tools;
  return tools.filter((tool) => {
    if (askUnattended && ASK_USER_QUESTION_TOOL_NAMES.some((name) => name === tool.name)) return false;
    if (isOneTurnDelegationBypassTool(tool.name, ctx)) return false;
    return !isToolDeniedByRunPolicy(runtimeToolPolicy(ctx), tool.name);
  });
}

/**
 * filterToolsByRunPolicy + 收窄可观测性。与 contextAssembly/inference.ts 里 A6
 * （strict_skill）/A8（artifact_repair）的日志 + TOOL_SCOPE_NARROWED 遥测对齐——
 * 之前 allowlist/denylist 收窄（如会话指挥台前台 brain）既不打日志也不发遥测，
 * 排查时无法定位收窄发生在哪一步（2026-08-07 T3 工具坍缩排查报告 §6）。
 * 就近放在 toolRunPolicy.ts 而非内联进 inference.ts，避免把后者推过 max-lines 门。
 *
 * 2026-08-09：日志补上**被剔除的工具名**。只打数量时它仍是半个盲区——委派入口歧义单
 * 前半程就卡在「24 -> 9 到底砍掉了谁」，只能翻真库 `session_events` 的
 * `tool_schema_snapshot` 反推（那是模型收到的**留存**名单，剔除名单得自己做差集）。
 * 名字才是能直接下结论的那一半：看见 `spawn_agent` 在 removed 里，
 * 「模型为什么不选它」这个问题当场就作废了。
 * 名单只进本地日志、不进遥测——MCP 工具名里可能带用户自己的服务器名。
 */
/** 收窄日志里最多列几个工具名：够定位，又不至于把一行日志刷到几百个名字。 */
const NARROWED_LOG_MAX_NAMES = 20;

export function filterToolsByRunPolicyObserved(
  tools: ToolDefinition[],
  ctx: RuntimeContext,
): ToolDefinition[] {
  const before = tools.length;
  const filtered = filterToolsByRunPolicy(tools, ctx);
  if (filtered.length !== before) {
    // 按对象身份做差集：filtered 是 tools.filter() 的产物，同名工具不会互相顶替。
    const kept = new Set<ToolDefinition>(filtered);
    const removed = tools.filter((item) => !kept.has(item)).map((item) => item.name);
    const shown = removed.slice(0, NARROWED_LOG_MAX_NAMES);
    logger.info(
      `[AgentLoop] Run policy toolset: tool list narrowed ${before} -> ${filtered.length}`,
      {
        removed: shown,
        ...(removed.length > shown.length
          ? { removedOverflow: removed.length - shown.length }
          : {}),
      },
    );
    trackNode(POSTHOG_EVENTS.TOOL_SCOPE_NARROWED, {
      sessionId: ctx.sessionId,
      narrowedBy: 'run_policy',
      before,
      after: filtered.length,
    });
  }
  return filtered;
}
