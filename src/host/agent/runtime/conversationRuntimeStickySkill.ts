// ============================================================================
// ConversationRuntime Sticky Strict Skill Resolution
// ============================================================================
// 从 ConversationRuntime 抽出的 sticky 严格技能恢复逻辑：会话历史里若有 create-role/
// edit-role 等严格技能种子，且当前轮不是斜杠命令，则恢复该技能调用。纯结构移动——
// 只读 ctx（messages / workingDirectory），把 ctx 当参数传入，行为与原私有方法一致。

import type { RuntimeContext } from './runtimeContext';
import {
  resolveSkillInvocation,
  type ResolvedSkillInvocation,
} from '../../services/skills/skillInvocationResolver';
import { logCollector } from '../../mcp/logCollector.js';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentLoop');

const STICKY_STRICT_SKILL_NAMES = new Set(['create-role', 'edit-role']);

function findLatestStrictSkillSeed(ctx: RuntimeContext): string | null {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const msg = ctx.messages[i];
    if (msg?.role !== 'user' || msg.visibility === 'rewound') {
      continue;
    }
    const text = msg.content.trim();
    if (/^\/(?:create-role|edit-role)(?:\s|$)/.test(text)) {
      return text;
    }
  }
  return null;
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

  const invocation = await resolveSkillInvocation(seed, ctx.workingDirectory);
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
