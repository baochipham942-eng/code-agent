// ============================================================================
// Conversation Review — 运行时 skill 自沉淀的 LLM 语义复盘链
// 借鉴 Hermes Agent 的 background_review：session 收尾时让 quick model 读对话内容，
// 判断本轮有没有"值得沉淀成一类技能"的可复用学习，产出一份 class-level skill 草稿。
//
// 与 learningPipeline 的 telemetry n-gram 蒸馏并联、互补：
//   - n-gram 蒸馏：只看工具调用序列，机械还原"点了哪几个工具"
//   - LLM 复盘（本模块）：读对话语义，提炼"这一类任务该怎么做 / 踩过什么坑"
// 产出仍走 skill-drafts 队列由用户确认入库（绝不自动入库），并打 origin=llm-review。
//
// 任何失败（模型不可用 / 超时 / 解析失败 / 无可沉淀内容）都返回 null = 本轮不沉淀，
// 静默降级，绝不阻塞会话、绝不污染主对话。
// ============================================================================

import { quickTask } from '../model/quickModel';
import { withTimeout } from '../services/infra/timeoutController';
import { createLogger } from '../services/infra/logger';
import { SKILL_REVIEW } from '../../shared/constants';

const logger = createLogger('ConversationReview');

/** LLM 复盘命中的信号类型（决定为什么要沉淀这条 skill） */
export type SkillReviewSignal =
  | 'user_correction' // 用户纠正了助手的做法
  | 'remember_request' // 用户明确说"记住/以后这样"
  | 'reusable_workflow' // 出现了一段可复用的工作流/解法
  | 'none'; // 没有可沉淀的学习

/** 一条经 LLM 复盘提炼出的 class-level skill 草稿（未落盘前的中间结构） */
export interface ReviewedSkill {
  /** 是否值得沉淀（false 时其余字段无意义） */
  shouldCreate: boolean;
  /** 命中的信号 */
  signal: SkillReviewSignal;
  /** 建议的 skill 名（kebab-case，class 级而非一次性实例） */
  name: string;
  /** 一句话描述这个 skill 覆盖的任务类别 */
  description: string;
  /** SKILL.md 正文（Markdown：针对这一类任务的可复用步骤/要点/坑） */
  body: string;
}

/** 把任意字符串规整成 kebab-case 的 skill 名 */
export function toSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_REVIEW.MAX_NAME_CHARS)
    .replace(/-+$/g, '');
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

// Hermes background_review 决策逻辑的本地化移植：要 ACTIVE，但只在有真正可复用学习时建，
// 目标是 class-level umbrella skill（这一类任务怎么做），不是流水账式一次性记录。
const REVIEW_PROMPT = `你是技能沉淀复盘器。阅读下面这段刚结束的会话，判断其中有没有"值得沉淀成一类可复用技能"的学习。

要点：
- 目标是 CLASS-LEVEL 技能：抽象出"这一类任务该怎么做"，而不是记录这次的具体实例（不要把具体文件名/具体数值写死成技能）。
- 主动一点，但只在确实学到可复用东西时才建。闲聊、单纯问答、没有方法论沉淀的对话 → shouldCreate=false。
- 触发信号（命中其一才考虑沉淀）：
  - user_correction：用户纠正了你的做法 / 指出更好的方式
  - remember_request：用户明确说"记住""以后都这样""下次要这样"
  - reusable_workflow：出现了一段清晰、可复用到同类任务的解法或工作流
- body 写成针对这一类任务的可复用指南（步骤、判断要点、踩过的坑），用 Markdown，不超过 ${SKILL_REVIEW.MAX_BODY_CHARS} 字。

只返回一个 JSON 对象，不要任何额外文字、不要 markdown 代码块：
{
  "shouldCreate": true 或 false,
  "signal": "user_correction" | "remember_request" | "reusable_workflow" | "none",
  "name": "kebab-case 的类级技能名，如 deploy-tauri-macos",
  "description": "不超过${SKILL_REVIEW.MAX_DESCRIPTION_CHARS}字、说明这个技能覆盖哪一类任务",
  "body": "Markdown 正文：这一类任务的可复用步骤/要点/坑"
}

若没有任何可沉淀的学习，返回 {"shouldCreate": false, "signal": "none", "name": "", "description": "", "body": ""}。`;

/** 构造投喂给复盘器的会话片段（最近 N 轮用户消息 + 最后助手回复） */
export function buildReviewSnippet(input: {
  userMessages: string[];
  lastAssistant?: string;
}): string {
  const recent = input.userMessages
    .filter((m) => m && m.trim().length > 0)
    .slice(-SKILL_REVIEW.RECENT_USER_TURNS);
  const lines = recent.map((msg, i) => `用户消息${i + 1}：${msg.trim()}`);
  if (input.lastAssistant && input.lastAssistant.trim()) {
    lines.push(`助手最后回复：${truncate(input.lastAssistant, SKILL_REVIEW.ASSISTANT_SNIPPET_CHARS)}`);
  }
  return lines.join('\n');
}

/** 组装完整复盘 prompt */
export function buildReviewPrompt(input: { userMessages: string[]; lastAssistant?: string }): string {
  return `${REVIEW_PROMPT}\n\n会话内容：\n${buildReviewSnippet(input)}`;
}

/**
 * 解析复盘器返回的 JSON。任何不合格（无 JSON / 缺字段 / 名字或正文为空）都返回 null。
 * 注意：shouldCreate=false 时也返回 null —— 上层无需关心"不沉淀"的细节。
 */
export function parseReviewedSkill(raw: string): ReviewedSkill | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.shouldCreate !== true) return null;

  const name = typeof obj.name === 'string' ? toSkillName(obj.name) : '';
  const description = typeof obj.description === 'string'
    ? truncate(obj.description, SKILL_REVIEW.MAX_DESCRIPTION_CHARS)
    : '';
  const body = typeof obj.body === 'string' ? truncate(obj.body, SKILL_REVIEW.MAX_BODY_CHARS) : '';

  // class-level skill 必须有可用的名字 + 描述 + 正文，缺一不可信
  if (!name || !description || !body) return null;

  const signal: SkillReviewSignal =
    obj.signal === 'user_correction' ||
    obj.signal === 'remember_request' ||
    obj.signal === 'reusable_workflow'
      ? obj.signal
      : 'reusable_workflow';

  return { shouldCreate: true, signal, name, description, body };
}

/**
 * 对一段会话做 LLM 语义复盘，返回一条值得沉淀的 class-level skill，或 null（本轮不沉淀）。
 * 用 quick（便宜/快）模型 + 硬超时；任何失败都返回 null，绝不抛错、绝不阻塞会话。
 */
export async function reviewConversationForSkill(input: {
  userMessages: string[];
  lastAssistant?: string;
}): Promise<ReviewedSkill | null> {
  const userMessages = input.userMessages.filter((m) => m && m.trim().length > 0);
  if (userMessages.length < SKILL_REVIEW.MIN_USER_TURNS) return null;

  try {
    const prompt = buildReviewPrompt({ userMessages, lastAssistant: input.lastAssistant });
    const result = await withTimeout(
      quickTask(prompt, SKILL_REVIEW.MAX_TOKENS),
      SKILL_REVIEW.TIMEOUT_MS,
      'Skill review timed out',
    );

    if (!result.success || !result.content) {
      logger.warn('Quick model unavailable for skill review', { error: result.error });
      return null;
    }

    const reviewed = parseReviewedSkill(result.content);
    if (reviewed) {
      logger.info('Conversation review distilled a skill candidate', {
        name: reviewed.name,
        signal: reviewed.signal,
      });
    }
    return reviewed;
  } catch (error) {
    logger.warn('Skill review failed, skipping', { error: String(error) });
    return null;
  }
}
