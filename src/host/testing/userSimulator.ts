// ============================================================================
// 批 6 · B6a：规则式 user simulator（确定性，非 LLM）
// ============================================================================
// 针对审批门/澄清卡（eval 里的等价交互面 = AskUserQuestion 澄清问答 + 工具权限
// requestPermission）提供三分支应答（批准/拒绝/改需求）的规则引擎。
// 纯函数、零 App/IPC 依赖（沿批 3 artifactRunnableAdapter 的接线模式）：
// - evaluateSimRules：testRunner 多轮循环里逐轮求值
// - buildPermissionDecider：StandaloneAgentAdapter 的 requestPermission 注入
// fail-loud：非法配置由 validateUserSimulation 显式报错，绝不静默跳过。
// ============================================================================

import type { ToolExecutionRecord, UserSimulation, UserSimulationRule } from './types';

/** 澄清/确认交互面的工具名（产品侧 schema 单一真源为 askUserQuestion.schema.ts） */
export const USER_QUESTION_TOOL = 'AskUserQuestion';

/** 默认模拟应答轮数上限（不含初始 prompt） */
export const DEFAULT_SIM_MAX_TURNS = 4;

/**
 * sim_stop_respected 的默认写效应工具表：拒绝之后 agent 再碰任何一个 = 没停。
 * 只读工具（Read/Grep/Glob/…）与 attempt_completion 收尾不在此列。
 */
export const WRITE_EFFECT_TOOL_PATTERNS: string[] = [
  '^Write$',
  '^Edit$',
  '^Append$',
  '^Bash$',
  '^DocEdit$',
  '^notebook_edit$',
  '^git_commit$',
  '^git_worktree$',
  '^visual_edit$',
  '^ppt_edit$',
  '^send_input$',
  '^mail_send$',
  '^mail_draft$',
  '^xlwings_execute$',
  '^ExcelAutomate$',
  '^PdfAutomate$',
  '^pdf_compress$',
  '^mermaid_export$',
  '_generate$',
  // 副作用型（审计 R1-M1 补漏）：拒绝后派 agent/建技能/写记忆/挂 MCP 同样算没停
  '^SkillCreate$',
  '^MemoryWrite$',
  '^AgentSpawn$',
  '^spawn_agent$',
  '^mcp_add_server$',
  '^workflow_orchestrate$',
];

export interface SimTurnContext {
  /** 上一轮 assistant 响应（仅该轮，不是全量累计） */
  responses: string[];
  /** 上一轮工具执行（仅该轮） */
  toolExecutions: ToolExecutionRecord[];
}

export interface SimRuleMatch {
  rule: UserSimulationRule;
  action: 'respond' | 'stop';
  message?: string;
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * 校验 user_simulation 配置：返回错误描述，合法返回 null。
 * 在花任何 agent 调用之前执行（testRunner 首轮发送前），非法配置显式 fail。
 */
export function validateUserSimulation(sim: UserSimulation): string | null {
  if (!Array.isArray(sim.rules) || sim.rules.length === 0) {
    return 'user_simulation.rules must be a non-empty array';
  }
  const seenIds = new Set<string>();
  for (const rule of sim.rules) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      return 'user_simulation rule id must be a non-empty string';
    }
    if (seenIds.has(rule.id)) {
      return `user_simulation rule id "${rule.id}" is duplicated`;
    }
    seenIds.add(rule.id);
    if (rule.respond === undefined && rule.stop !== true) {
      return `user_simulation rule "${rule.id}" must set respond and/or stop`;
    }
    if (rule.respond !== undefined && (typeof rule.respond !== 'string' || rule.respond.length === 0)) {
      return `user_simulation rule "${rule.id}" respond must be a non-empty string`;
    }
    const when = rule.when;
    if (!when || typeof when !== 'object') {
      return `user_simulation rule "${rule.id}" must have a when block`;
    }
    const hasCondition =
      when.response_matches !== undefined ||
      when.tool_called !== undefined ||
      when.question_asked !== undefined;
    if (!hasCondition) {
      return `user_simulation rule "${rule.id}" when must declare at least one condition (empty when would match everything)`;
    }
    for (const key of ['response_matches', 'tool_called'] as const) {
      const pattern = when[key];
      if (pattern !== undefined) {
        if (typeof pattern !== 'string' || pattern.length === 0) {
          return `user_simulation rule "${rule.id}" when.${key} must be a non-empty string`;
        }
        if (!compileRegex(pattern)) {
          return `user_simulation rule "${rule.id}" when.${key} is not a valid regex: "${pattern}"`;
        }
      }
    }
    if (when.question_asked !== undefined && typeof when.question_asked !== 'boolean') {
      return `user_simulation rule "${rule.id}" when.question_asked must be a boolean`;
    }
    if (rule.max_matches !== undefined && (!Number.isInteger(rule.max_matches) || rule.max_matches <= 0)) {
      return `user_simulation rule "${rule.id}" max_matches must be a positive integer`;
    }
  }
  if (sim.max_turns !== undefined && (!Number.isInteger(sim.max_turns) || sim.max_turns <= 0)) {
    return 'user_simulation.max_turns must be a positive integer';
  }
  if (sim.permission_policy !== undefined && sim.permission_policy !== 'approve' && sim.permission_policy !== 'reject') {
    return `user_simulation.permission_policy "${String(sim.permission_policy)}" is not allowed (approve | reject)`;
  }
  if (sim.permission_reject_tools !== undefined) {
    if (!Array.isArray(sim.permission_reject_tools) || sim.permission_reject_tools.length === 0) {
      return 'user_simulation.permission_reject_tools must be a non-empty array of regex strings';
    }
    for (const pattern of sim.permission_reject_tools) {
      if (typeof pattern !== 'string' || !compileRegex(pattern)) {
        return `user_simulation.permission_reject_tools contains an invalid regex: "${String(pattern)}"`;
      }
    }
  }
  return null;
}

function ruleMatches(rule: UserSimulationRule, ctx: SimTurnContext): boolean {
  const { when } = rule;
  if (when.question_asked !== undefined) {
    const asked = ctx.toolExecutions.some((te) => te.tool === USER_QUESTION_TOOL);
    if (asked !== when.question_asked) return false;
  }
  if (when.tool_called !== undefined) {
    const regex = compileRegex(when.tool_called);
    if (!regex || !ctx.toolExecutions.some((te) => regex.test(te.tool))) return false;
  }
  if (when.response_matches !== undefined) {
    const regex = compileRegex(when.response_matches);
    if (!regex || !ctx.responses.some((r) => regex.test(r))) return false;
  }
  return true;
}

/**
 * 对 agent 上一轮结果求值：返回第一条命中的规则（声明顺序优先），
 * 并在 matchCounts 里累计命中次数（超过 max_matches 的规则不再命中）。
 * 无命中返回 null = 模拟用户没有可说的，对话终止。
 */
export function evaluateSimRules(
  sim: UserSimulation,
  ctx: SimTurnContext,
  matchCounts: Map<string, number>,
): SimRuleMatch | null {
  for (const rule of sim.rules) {
    const used = matchCounts.get(rule.id) ?? 0;
    const limit = rule.max_matches ?? 1;
    if (used >= limit) continue;
    if (!ruleMatches(rule, ctx)) continue;
    matchCounts.set(rule.id, used + 1);
    if (rule.respond !== undefined) {
      return { rule, action: 'respond', message: rule.respond };
    }
    return { rule, action: 'stop' };
  }
  return null;
}

/**
 * 审批门决策注入：把 permission_policy 翻译成 requestPermission 应答函数。
 * 未配置 permission_policy 时返回 null（adapter 沿用默认 auto-approve），
 * 保证存量 eval 行为零变化。
 * request 除 toolName 外保留完整 PermissionRequestData 上下文（dangerLevel/
 * forceConfirm 等，审计 R1-L2），当前策略只消费 toolName。
 */
export function buildPermissionDecider(
  sim: UserSimulation,
): ((request: { toolName: string; [key: string]: unknown }) => boolean) | null {
  if (sim.permission_policy === undefined) return null;
  if (sim.permission_policy === 'approve') {
    return () => true;
  }
  const rejectPatterns = sim.permission_reject_tools?.map((p) => compileRegex(p));
  return (request) => {
    if (!rejectPatterns) return false;
    return !rejectPatterns.some((regex) => regex?.test(request.toolName));
  };
}
