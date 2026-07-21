// ============================================================================
// ConversationRuntime Sticky Strict Skill Resolution
// ============================================================================
// 会话历史里若有 create-role/edit-role 严格技能种子，且当前轮不是斜杠命令，
// 则恢复该技能调用（含 strict 工具集收窄）。
//
// 退出条件（2026-07-21：真实故障 = 建角色草稿晾着时，无关请求也被锁在 5 个工具里，
// 模型只能对用户说"环境受限"）。恢复必须同时满足：
//   1. 流程仍在进行：本会话存在 pending 角色草稿（等确认阶段），
//      或尚无本会话草稿但种子仍在最近 INTERVIEW_WINDOW_TURNS 条 user 消息内（访谈阶段）；
//   2. 未显式退出：种子之后历史里没有出现过 exit_role_flow 工具调用。
// ============================================================================

import type { RuntimeContext } from './runtimeContext';
import {
  resolveSkillInvocation,
  type ResolvedSkillInvocation,
} from '../../services/skills/skillInvocationResolver';
import { listRoleDrafts } from '../../services/roleAssets/roleDraftQueue';
import { EXIT_ROLE_FLOW_TOOL_NAME } from '../../tools/modules/roleAuthoring/exitRoleFlow.schema';
import { logCollector } from '../../mcp/logCollector.js';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentLoop');

const STICKY_STRICT_SKILL_NAMES = new Set(['create-role', 'edit-role']);

/** 访谈阶段窗口：种子之后超过这么多条 user 消息且仍无本会话草稿，视为流程已被放弃 */
const INTERVIEW_WINDOW_TURNS = 3;

interface StrictSkillSeed {
  text: string;
  /** 种子在 ctx.messages 中的下标 */
  index: number;
}

function findLatestStrictSkillSeed(ctx: RuntimeContext): StrictSkillSeed | null {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const msg = ctx.messages[i];
    if (msg?.role !== 'user' || msg.visibility === 'rewound') {
      continue;
    }
    const text = msg.content.trim();
    if (/^\/(?:create-role|edit-role)(?:\s|$)/.test(text)) {
      return { text, index: i };
    }
  }
  return null;
}

/** 种子之后历史里出现过 exit_role_flow 调用 → 已显式退出流程，不再恢复 */
function hasExitedRoleFlowSince(ctx: RuntimeContext, seedIndex: number): boolean {
  for (let i = seedIndex + 1; i < ctx.messages.length; i++) {
    const msg = ctx.messages[i];
    if (msg?.role !== 'assistant') continue;
    if (msg.toolCalls?.some((call) => call.name === EXIT_ROLE_FLOW_TOOL_NAME)) {
      return true;
    }
  }
  return false;
}

/** 种子之后的 user 消息条数（不含种子本身与 rewound） */
function userTurnsSinceSeed(ctx: RuntimeContext, seedIndex: number): number {
  let count = 0;
  for (let i = seedIndex + 1; i < ctx.messages.length; i++) {
    const msg = ctx.messages[i];
    if (msg?.role === 'user' && msg.visibility !== 'rewound') count++;
  }
  return count;
}

/** 本会话是否还有 pending 角色草稿（读盘失败按"无草稿"处理，退回访谈窗口判定） */
async function hasPendingDraftForSession(sessionId: string): Promise<boolean> {
  try {
    const drafts = await listRoleDrafts();
    return drafts.some((draft) => draft.sessionId === sessionId);
  } catch (error) {
    logger.warn('[AgentLoop] Sticky skill: listRoleDrafts failed, treating as no pending draft', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function isStickyStrictSkill(invocation: ResolvedSkillInvocation): boolean {
  return invocation.skill.strictToolset === true
    && STICKY_STRICT_SKILL_NAMES.has(invocation.skill.name);
}

export async function resolveStickyStrictSkillInvocation(
  ctx: RuntimeContext,
  userMessage: string,
): Promise<ResolvedSkillInvocation | null> {
  if (userMessage.trim().startsWith('/')) {
    return null;
  }

  const seed = findLatestStrictSkillSeed(ctx);
  if (!seed) {
    return null;
  }

  // 退出条件 2：显式退出过就永不恢复
  if (hasExitedRoleFlowSince(ctx, seed.index)) {
    logger.info('[AgentLoop] Sticky strict skill NOT restored: exit_role_flow found after seed');
    return null;
  }

  // 退出条件 1：流程须仍在进行（pending 草稿，或访谈窗口内）
  const flowStillActive =
    userTurnsSinceSeed(ctx, seed.index) < INTERVIEW_WINDOW_TURNS
    || (await hasPendingDraftForSession(ctx.sessionId));
  if (!flowStillActive) {
    logger.info('[AgentLoop] Sticky strict skill NOT restored: no pending draft and interview window elapsed');
    return null;
  }

  const invocation = await resolveSkillInvocation(seed.text, ctx.workingDirectory);
  if (!invocation || !isStickyStrictSkill(invocation)) {
    return null;
  }

  logger.info('[AgentLoop] Restored sticky strict skill invocation from session history', {
    skillName: invocation.skill.name,
    matchKind: invocation.matchKind,
    matchedText: invocation.matchedText,
  });
  logCollector.agent('INFO', `Sticky strict skill invocation restored: ${invocation.skill.name}`, {
    matchKind: invocation.matchKind,
    matchedText: invocation.matchedText,
  });

  return invocation;
}
