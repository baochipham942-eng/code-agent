// ============================================================================
// Conversation Judge — Session-end LLM judgment for Light Memory
// Replaces the old "slice first 50 chars as title" heuristic with a quick-model
// judgment: is this conversation worth keeping, is it a meeting, a real title,
// and the durable knowledge worth remembering.
//
// Runs on the quick (cheap/fast) model and degrades gracefully to the previous
// truncation heuristic when the quick model is unavailable or fails, so a model
// outage never drops summaries.
// ============================================================================

import { quickTask } from '../model/quickModel';
import { withTimeout } from '../services/infra/timeoutController';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';

const logger = createLogger('ConversationJudge');

export interface ConversationJudgment {
  /** Whether this conversation is worth persisting to recent-conversations. */
  worth: boolean;
  /** Whether this looks like a meeting / transcription / minutes. */
  isMeeting: boolean;
  /** Concise topic title. */
  title: string;
  /** 1-3 durable user intents / key facts worth remembering. */
  worthKnowledge: string[];
  /** How the judgment was produced (observability). */
  source: 'llm' | 'heuristic';
}

const MAX_TITLE_CHARS = 50;
const MAX_HIGHLIGHT_CHARS = 60;
const MAX_HIGHLIGHTS = 3;

const JUDGE_PROMPT = `你是会话归档判断器。根据下面这段会话，判断它是否值得长期留存，并给出标题和要点。

只返回一个 JSON 对象，不要任何额外文字、不要 markdown 代码块：
{
  "worth": true 或 false,
  "isMeeting": true 或 false,
  "title": "不超过40字的简洁中文标题",
  "worthKnowledge": ["1-3 条值得记住的用户意图或关键信息，每条不超过60字"]
}

判断规则：
- worth=false：闲聊、打招呼、"继续"/"好的"/"ok"/单字确认、无信息量的测试性输入。
- worth=true：有明确任务、决策、需求、知识点的会话。
- isMeeting=true：会议记录、录音转录、会议纪要、多人对话纪要类内容。
- title 抓住会话主题；worthKnowledge 抓住用户真正想达成什么、定了什么。`;

/**
 * Truncate a string to a max length with an ellipsis.
 */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() + '...' : trimmed;
}

/**
 * Heuristic judgment — mirrors the previous extractAndSaveConversationSummary
 * behavior so behavior never regresses when the quick model is unavailable.
 */
function heuristicJudgment(userMessages: string[]): ConversationJudgment {
  const latest = userMessages[userMessages.length - 1] ?? '';
  const title = truncate(latest, MAX_TITLE_CHARS);

  const worthKnowledge = userMessages
    .slice(-5)
    .map((msg) => {
      const firstLine = msg.split('\n')[0].trim();
      return firstLine.length > MAX_HIGHLIGHT_CHARS
        ? firstLine.slice(0, MAX_HIGHLIGHT_CHARS) + '...'
        : firstLine;
    })
    .filter((v, i, a) => v.length > 0 && a.indexOf(v) === i)
    .reverse()
    .slice(0, MAX_HIGHLIGHTS);

  return { worth: true, isMeeting: false, title, worthKnowledge, source: 'heuristic' };
}

/**
 * Extract and parse the JSON object from a quick-model response.
 * Returns null if no valid object can be parsed.
 */
function parseJudgment(raw: string): ConversationJudgment | null {
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

  const title = typeof obj.title === 'string' ? truncate(obj.title, MAX_TITLE_CHARS) : '';
  if (!title) return null; // a judgment without a usable title is not trustworthy

  const worthKnowledge = Array.isArray(obj.worthKnowledge)
    ? obj.worthKnowledge
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => truncate(v, MAX_HIGHLIGHT_CHARS))
        .slice(0, MAX_HIGHLIGHTS)
    : [];

  return {
    worth: obj.worth !== false, // default to keeping unless explicitly false
    isMeeting: obj.isMeeting === true,
    title,
    worthKnowledge,
    source: 'llm',
  };
}

/**
 * Build the conversation snippet fed to the judge.
 */
function buildConversationSnippet(userMessages: string[], lastAssistant?: string): string {
  const recent = userMessages.slice(-SESSION_JUDGE.RECENT_USER_TURNS);
  const lines = recent.map((msg, i) => `用户消息${i + 1}：${msg.trim()}`);
  if (lastAssistant?.trim()) {
    lines.push(`助手最后回复：${truncate(lastAssistant, 300)}`);
  }
  return lines.join('\n');
}

/**
 * Judge a conversation for Light Memory archival.
 *
 * Uses the quick model with a hard timeout; falls back to the truncation
 * heuristic on any failure so summaries are never silently lost.
 */
export async function judgeConversation(input: {
  userMessages: string[];
  lastAssistant?: string;
}): Promise<ConversationJudgment> {
  const userMessages = input.userMessages.filter((m) => m && m.trim().length > 0);
  if (userMessages.length === 0) {
    return { worth: false, isMeeting: false, title: '', worthKnowledge: [], source: 'heuristic' };
  }

  try {
    const prompt = `${JUDGE_PROMPT}\n\n会话内容：\n${buildConversationSnippet(userMessages, input.lastAssistant)}`;
    const result = await withTimeout(
      quickTask(prompt, SESSION_JUDGE.MAX_TOKENS),
      SESSION_JUDGE.TIMEOUT_MS,
      'Conversation judgment timed out',
    );

    if (result.success && result.content) {
      const judgment = parseJudgment(result.content);
      if (judgment) {
        logger.info('Conversation judged via LLM', {
          worth: judgment.worth,
          isMeeting: judgment.isMeeting,
          title: judgment.title.slice(0, 30),
        });
        // If the LLM judges it worth keeping but extracted no knowledge points,
        // backfill from the heuristic so the summary still carries highlights.
        if (judgment.worth && judgment.worthKnowledge.length === 0) {
          judgment.worthKnowledge = heuristicJudgment(userMessages).worthKnowledge;
        }
        return judgment;
      }
      logger.warn('Conversation judgment unparsable, using heuristic', {
        sample: result.content.slice(0, 120),
      });
    } else {
      logger.warn('Quick model unavailable for judgment, using heuristic', { error: result.error });
    }
  } catch (error) {
    logger.warn('Conversation judgment failed, using heuristic', { error: String(error) });
  }

  return heuristicJudgment(userMessages);
}
