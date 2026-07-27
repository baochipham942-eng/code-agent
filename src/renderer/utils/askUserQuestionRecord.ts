// ============================================================================
// askUserQuestionRecord —— AskUserQuestion 工具步骤 → 消息流 Q&A 记录（G2）
//
// 打断式选项卡回答后，问题与所选答案要能在消息流里回看。载体就是持久化的
// AskUserQuestion 工具步骤：args.questions 带全部题目，result.output 是 host
// 侧固定格式（askUserQuestion.ts）：
//   回答："User responses:\n[header]: answer\n[header2]: answer2"
//   跳过："User declined to answer." / "User declined to answer. Reason: xxx"
// 这里把它解析成结构化记录供 ToolCallDisplay 渲染。纯函数，便于单测。
// 答案允许跨行（"其他"自由文本）：只有以 [已知header]: 开头的行才切开新答案，
// 其余行并入上一个答案——header 取自 args.questions，不盲信任意方括号行。
// ============================================================================

import type { ToolCall } from '@shared/contract';
import type { UserQuestion } from '@shared/contract';

interface AskUserQuestionRecordItem {
  header: string;
  question: string;
  /** 该题所选答案（多选已 join）；跳过的题恒为 null */
  answer: string | null;
}

export interface AskUserQuestionRecord {
  kind: 'answered' | 'declined';
  /** 用户跳过时可填的原因 */
  declineReason?: string;
  items: AskUserQuestionRecordItem[];
}

const DECLINED_PREFIX = 'User declined to answer.';
const DECLINED_REASON_MARKER = 'Reason: ';
const RESPONSES_PREFIX = 'User responses:';

function readQuestions(toolCall: ToolCall): UserQuestion[] | null {
  const args = toolCall.arguments as Record<string, unknown> | undefined;
  const raw = args?.questions;
  if (!Array.isArray(raw)) return null;
  const questions = raw.filter(
    (q): q is UserQuestion =>
      Boolean(q) &&
      typeof q === 'object' &&
      typeof (q as UserQuestion).header === 'string' &&
      typeof (q as UserQuestion).question === 'string',
  );
  return questions.length > 0 ? questions : null;
}

function parseAnswers(output: string, headers: string[]): Map<string, string> {
  const known = new Set(headers);
  const answers = new Map<string, string>();
  let currentHeader: string | null = null;
  for (const line of output.split('\n')) {
    const match = /^\[([^\]]+)\]:[ \t]?(.*)$/.exec(line);
    if (match && known.has(match[1])) {
      currentHeader = match[1];
      answers.set(currentHeader, match[2]);
    } else if (currentHeader !== null && line.trim().length > 0) {
      answers.set(currentHeader, `${answers.get(currentHeader)}\n${line}`);
    }
  }
  return answers;
}

export function buildAskUserQuestionRecord(toolCall: ToolCall): AskUserQuestionRecord | null {
  if (toolCall.name !== 'AskUserQuestion') return null;
  const questions = readQuestions(toolCall);
  if (!questions) return null;
  const output = toolCall.result?.output;
  if (typeof output !== 'string' || output.length === 0) return null;

  if (output.startsWith(DECLINED_PREFIX)) {
    const rest = output.slice(DECLINED_PREFIX.length).trim();
    const reason = rest.startsWith(DECLINED_REASON_MARKER)
      ? rest.slice(DECLINED_REASON_MARKER.length).trim()
      : undefined;
    return {
      kind: 'declined',
      ...(reason ? { declineReason: reason } : {}),
      items: questions.map((q) => ({ header: q.header, question: q.question, answer: null })),
    };
  }

  if (!output.startsWith(RESPONSES_PREFIX)) return null;
  const answers = parseAnswers(output, questions.map((q) => q.header));
  return {
    kind: 'answered',
    items: questions.map((q) => ({
      header: q.header,
      question: q.question,
      answer: answers.get(q.header) ?? null,
    })),
  };
}
