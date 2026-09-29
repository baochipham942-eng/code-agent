// ============================================================================
// Conversation Judge — Session-end LLM judgment for Light Memory
// Replaces the old "slice first 50 chars as title" heuristic with a memory-model
// judgment: is this conversation worth keeping, is it a meeting, a real title,
// and the durable knowledge worth remembering.
//
// Runs on the configurable memory model (default: routing.fast) and degrades
// gracefully to the previous truncation heuristic when the model is unavailable or fails, so a model
// outage never drops summaries.
// ============================================================================

import * as path from 'path';
import { memoryTask } from '../model/quickModel';
import { withTimeout } from '../services/infra/timeoutController';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';
import { listMemoryFiles } from './lightMemoryIpc';

const logger = createLogger('ConversationJudge');

export interface DurableFact {
  /** 必须以 .md 结尾，且不能包含路径分隔符。 */
  filename: string;
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
  /** 判断器给出的置信度 (0-1)。缺失/越界时解析侧回落保守缺省（candidate 档），不放大。 */
  confidence: number;
  /** 可选：这条事实修正/取代的现有记忆文件名（仅 user/feedback 在写入侧生效）。 */
  supersedes?: string;
}

export interface ConversationJudgment {
  /** 是否值得写入 recent-conversations。 */
  worth: boolean;
  /** 是否为会议、转录或纪要类内容。 */
  isMeeting: boolean;
  /** 简洁的会话主题。 */
  title: string;
  /** 1-3 条值得记住的用户意图或关键信息。 */
  worthKnowledge: string[];
  /** 跨会话仍然成立的稳定用户事实。 */
  durableFacts: DurableFact[];
  /** 判断来源，用于可观测性。 */
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
  "worthKnowledge": ["1-3 条值得记住的用户意图或关键信息，每条不超过60字"],
  "durableFacts": [
    {
      "filename": "稳定、可复用的英文短文件名.md",
      "name": "事实名称",
      "description": "一句话说明这条记忆是什么",
      "type": "user | feedback | project | reference 四选一",
      "content": "下次会话可直接使用的完整事实",
      "confidence": "0到1之间的小数，表示这条事实跨会话仍然成立的把握",
      "supersedes": "可选；若这条事实修正或取代了现有记忆文件清单中的某个文件，填那个文件名，否则省略该字段"
    }
  ]
}

判断规则：
- worth=false：闲聊、打招呼、"继续"/"好的"/"ok"/单字确认、无信息量的测试性输入。
- worth=true：有明确任务、决策、需求、知识点的会话。
- isMeeting=true：会议记录、录音转录、会议纪要、多人对话纪要类内容。
- title 抓住会话主题；worthKnowledge 抓住用户真正想达成什么、定了什么。
- durableFacts 只收用户在对话中顺带透露、下次仍然成立的稳定事实，例如所在城市、家庭构成、预算档位、口味或忌口、常用平台与账号、明确表达的工作偏好，或用户对你的纠正。
- 最强信号：你为了完成任务向用户问了一个问题，用户回答了，而且这个答案下次仍然成立。这种事实必须收进 durableFacts。
- durableFacts 不收本次任务的临时状态、不收能从材料本身推导出的代码或文档或数据自带信息、不收闲聊和一次性调试细节。
- durableFacts 返回空数组是正常结果，宁缺勿滥；绝大多数轮次都应该返回 []。
- confidence 校准：用户亲口明说、且明确跨会话成立的给 0.8 以上；从措辞推断或可能只在本任务成立的给 0.5 以下；拿不准给中间值，不要为了写进而抬高。
- supersedes 只能从下面给出的现有记忆文件清单里选；清单为空或没有可取代的文件时必须省略，禁止编造文件名。
- directive 类记忆不会出现在清单里：它们由用户显式确认建立、只能由用户移除，supersedes 永远不许指向 directive，即使你猜到了文件名。`;

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

  return { worth: true, isMeeting: false, title, worthKnowledge, durableFacts: [], source: 'heuristic' };
}

const DURABLE_FACT_TYPES = new Set<DurableFact['type']>([
  'user',
  'feedback',
  'project',
  'reference',
]);

/**
 * 置信度缺省与夹取：缺失或越界（非有限数 / 超出 [0,1]）一律回落保守缺省
 * （candidate 档中部）——模型漏给字段时既不放大成 active，也不静默丢弃。
 */
function normalizeDurableFactConfidence(value: unknown): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
    ? value
    : SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_MISSING_DEFAULT;
}

/**
 * supersedes 形状校验：与 filename 同规则（.md 结尾、无路径分量），
 * 且不得指向自身；不合法时丢弃该字段（事实本身照常写入）。
 */
function normalizeDurableFactSupersedes(value: unknown, filename: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const supersedes = value.trim();
  if (
    !supersedes.endsWith('.md')
    || path.basename(supersedes) !== supersedes
    || path.win32.basename(supersedes) !== supersedes
    || supersedes === filename
  ) {
    return undefined;
  }
  return supersedes;
}

function parseDurableFacts(value: unknown): DurableFact[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((candidate): DurableFact[] => {
      if (typeof candidate !== 'object' || candidate === null) return [];
      const fact = candidate as Record<string, unknown>;
      if (
        typeof fact.filename !== 'string'
        || typeof fact.name !== 'string'
        || typeof fact.description !== 'string'
        || typeof fact.type !== 'string'
        || typeof fact.content !== 'string'
      ) {
        return [];
      }

      const filename = fact.filename.trim();
      const name = fact.name.trim();
      const description = fact.description.trim();
      const content = fact.content.trim();
      if (
        !filename.endsWith('.md')
        || path.basename(filename) !== filename
        || path.win32.basename(filename) !== filename
        || !DURABLE_FACT_TYPES.has(fact.type as DurableFact['type'])
        || !name
        || !description
        || !content
      ) {
        return [];
      }

      return [{
        filename,
        name,
        description,
        type: fact.type as DurableFact['type'],
        content: content.slice(0, SESSION_JUDGE.MAX_DURABLE_FACT_CHARS).trim(),
        confidence: normalizeDurableFactConfidence(fact.confidence),
        supersedes: normalizeDurableFactSupersedes(fact.supersedes, filename),
      }];
    })
    .slice(0, SESSION_JUDGE.MAX_DURABLE_FACTS);
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
  const durableFacts = parseDurableFacts(obj.durableFacts);

  return {
    worth: obj.worth !== false, // default to keeping unless explicitly false
    isMeeting: obj.isMeeting === true,
    title,
    worthKnowledge,
    durableFacts,
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
 * 现有记忆文件清单（active 且非 directive 的记忆文件）。
 * 拼进判断器输入，让 supersedes 能指向真实存在的文件而不是编造文件名。
 * r3：① directive 不进清单——其建立要过交互确认门，自动 supersedes 顶不掉，
 * 列出来只会诱导判断器产出注定被忽略的 supersedes（写入侧另有旧条目类型门兜底）；
 * ② 条数封顶，输入 token 不随记忆量无界增长（超出部分本次不可被 supersedes，
 * 保守无害）。来源从 INDEX 目标改为全目录扫描 + active 过滤：类型信息在文件
 * frontmatter 里而不在 INDEX 行里，且与 INDEX 收录同判据（status 缺省按 active）。
 */
async function listExistingMemoryFilenames(): Promise<string[]> {
  try {
    const files = await listMemoryFiles();
    return files
      .filter((file) => (file.status ?? 'active') === 'active' && file.type !== 'directive')
      .map((file) => file.filename)
      .slice(0, SESSION_JUDGE.DURABLE_FACT_SUPERSEDES_LIST_MAX);
  } catch (error) {
    logger.warn('读取记忆文件清单失败，supersedes 将拿不到现有文件清单', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function buildSupersedesFileListPrompt(filenames: string[]): string {
  if (filenames.length === 0) {
    return '\n\n现有记忆文件清单：空（本次所有 supersedes 字段必须省略）。';
  }
  return `\n\n现有记忆文件清单（supersedes 只能从中选择）：\n${filenames.map((f) => `- ${f}`).join('\n')}`;
}

/**
 * Judge a conversation for Light Memory archival.
 *
 * Uses the configurable memory model with a hard timeout; falls back to the truncation
 * heuristic on any failure so summaries are never silently lost.
 */
export async function judgeConversation(input: {
  userMessages: string[];
  lastAssistant?: string;
}): Promise<ConversationJudgment> {
  const userMessages = input.userMessages.filter((m) => m && m.trim().length > 0);
  if (userMessages.length === 0) {
    return {
      worth: false,
      isMeeting: false,
      title: '',
      worthKnowledge: [],
      durableFacts: [],
      source: 'heuristic',
    };
  }

  try {
    const existingFilenames = await listExistingMemoryFilenames();
    const prompt = `${JUDGE_PROMPT}${buildSupersedesFileListPrompt(existingFilenames)}\n\n会话内容：\n${buildConversationSnippet(userMessages, input.lastAssistant)}`;
    const result = await withTimeout(
      memoryTask(prompt, SESSION_JUDGE.MAX_TOKENS),
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
