import type {
  UserQuestion,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../../shared/contract';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceQuestionBridge');

interface VoiceQuestionBinding {
  neoSessionId: string;
  speak: (input: { narrationId: string; title: string; text: string }) => void;
  dismiss: (narrationPrefix: string) => void;
}

interface PendingVoiceQuestion {
  request: UserQuestionRequest;
  index: number;
  answers: Record<string, string | string[]>;
  fallbackAsked: boolean;
  respond: (response: UserQuestionResponse) => void;
}

let binding: VoiceQuestionBinding | null = null;
let pending: PendingVoiceQuestion | null = null;
const queued: PendingVoiceQuestion[] = [];

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。！？、,.!?：:；;（）()“”"'-]/g, '');
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

const ORDINALS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4,
  第一个: 1, 第二个: 2, 第三个: 3, 第四个: 4,
};

function ordinalIndexes(text: string, optionCount: number): number[] {
  const normalized = normalize(text);
  const indexes = new Set<number>();
  for (const match of normalized.matchAll(/(?:第)?([1-4])(?:个|项|号)?/g)) {
    const index = Number(match[1]);
    if (index >= 1 && index <= optionCount) indexes.add(index - 1);
  }
  for (const [token, index] of Object.entries(ORDINALS)) {
    if (normalized.includes(token) && index <= optionCount) indexes.add(index - 1);
  }
  return [...indexes];
}

/** 语音转写 → 既有选项 label。无法唯一确认时返回 null，绝不替用户猜。 */
export function matchVoiceQuestionAnswer(
  question: UserQuestion,
  transcript: string,
): string | string[] | null {
  const spoken = normalize(transcript);
  if (!spoken) return null;
  const indexed = ordinalIndexes(transcript, question.options.length);
  if (indexed.length) {
    const labels = indexed.map((index) => question.options[index]?.label).filter(Boolean) as string[];
    if (question.multiSelect) return labels;
    return labels.length === 1 ? labels[0] : null;
  }

  const contained = question.options.filter((option) => {
    const label = normalize(option.label);
    return label && (spoken.includes(label) || label.includes(spoken));
  });
  if (question.multiSelect && contained.length) return contained.map((option) => option.label);
  if (contained.length === 1) return contained[0]?.label ?? null;
  if (contained.length > 1) return null;

  const ranked = question.options
    .map((option) => {
      const label = normalize(option.label);
      const width = Math.max(spoken.length, label.length, 1);
      return { label: option.label, score: 1 - editDistance(spoken, label) / width };
    })
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 0.6 || (second && best.score - second.score < 0.15)) return null;
  return question.multiSelect ? [best.label] : best.label;
}

function narrationText(question: UserQuestion, fallback: boolean): string {
  const options = question.options
    .map((option, index) => `${index + 1}，${option.label}：${option.description}`)
    .join('；');
  if (fallback) {
    return [
      `用户需要回答「${question.header}」。刚才的回答没有唯一对应到选项。`,
      `现在只追问一次：「请直接说选项名称或编号。${options}」`,
      '不要替用户选择，不要回答别的问题。',
    ].join('\n');
  }
  return [
    `用户需要回答「${question.header}」。`,
    `现在只问：「${question.question}」选项是：${options}。`,
    '等用户回答，不要替他选择，不要回答别的问题。',
  ].join('\n');
}

function speakCurrent(): void {
  if (!binding || !pending) return;
  const question = pending.request.questions[pending.index];
  if (!question) return;
  const narrationId = `voice-question:${pending.request.id}:${pending.index}:${pending.fallbackAsked ? 'retry' : 'ask'}`;
  logger.info('voice question narration requested', {
    requestId: pending.request.id,
    neoSessionId: binding.neoSessionId,
    narrationId,
    questionIndex: pending.index,
    fallbackAsked: pending.fallbackAsked,
  });
  binding.speak({
    narrationId,
    title: question.header,
    text: narrationText(question, pending.fallbackAsked),
  });
}

function advanceQueue(): void {
  pending = queued.shift() ?? null;
  if (pending) speakCurrent();
}

export function beginVoiceQuestionSession(next: VoiceQuestionBinding): void {
  binding = next;
  queued.length = 0;
  logger.info('voice question session bound', { neoSessionId: next.neoSessionId });
}

export function canOfferVoiceQuestion(neoSessionId: string | undefined): boolean {
  return Boolean(binding && neoSessionId && binding.neoSessionId === neoSessionId);
}

export function endVoiceQuestionSession(neoSessionId: string): void {
  if (binding?.neoSessionId !== neoSessionId) return;
  logger.info('voice question session unbound', {
    neoSessionId,
    pendingRequestId: pending?.request.id,
    queuedCount: queued.length,
  });
  binding = null;
  pending = null;
  queued.length = 0;
}

export function offerVoiceQuestion(
  request: UserQuestionRequest,
  respond: (response: UserQuestionResponse) => void,
): boolean {
  if (!binding || binding.neoSessionId !== request.sessionId) {
    logger.warn('voice question route unavailable', {
      requestId: request.id,
      requestedSessionId: request.sessionId,
      boundSessionId: binding?.neoSessionId,
      hasBinding: Boolean(binding),
    });
    return false;
  }
  const offered = { request, index: 0, answers: {}, fallbackAsked: false, respond };
  if (pending) {
    queued.push(offered);
    logger.info('voice question queued', {
      requestId: request.id,
      neoSessionId: binding.neoSessionId,
      queuedCount: queued.length,
    });
  }
  else {
    pending = offered;
    logger.info('voice question accepted', {
      requestId: request.id,
      neoSessionId: binding.neoSessionId,
    });
    speakCurrent();
  }
  return true;
}

export function cancelVoiceQuestion(requestId: string): void {
  if (pending?.request.id === requestId) {
    binding?.dismiss(`voice-question:${requestId}:`);
    advanceQueue();
    return;
  }
  const queuedIndex = queued.findIndex((item) => item.request.id === requestId);
  if (queuedIndex >= 0) queued.splice(queuedIndex, 1);
}

/** @returns true 表示该 final 是选项回答，调用方不得再让通话 brain 生成普通回复。 */
export function handleVoiceQuestionTranscript(neoSessionId: string, transcript: string): boolean {
  if (binding?.neoSessionId !== neoSessionId || !pending) return false;
  const question = pending.request.questions[pending.index];
  if (!question) return false;
  const answer = matchVoiceQuestionAnswer(question, transcript);
  if (answer !== null) {
    logger.info('voice question answer accepted', {
      requestId: pending.request.id,
      neoSessionId,
      questionIndex: pending.index,
    });
    binding.dismiss(`voice-question:${pending.request.id}:${pending.index}:`);
    pending.answers[question.header] = answer;
    pending.index += 1;
    pending.fallbackAsked = false;
    if (pending.index < pending.request.questions.length) {
      speakCurrent();
      return true;
    }
    const completed = pending;
    // `respond` enters the shared prompt settlement synchronously, which calls
    // cancelVoiceQuestion(requestId). Detach the completed item first so that
    // settlement cannot advance the queue and make this frame advance it again.
    pending = null;
    completed.respond({ requestId: completed.request.id, answers: completed.answers });
    advanceQueue();
    return true;
  }

  if (!pending.fallbackAsked) {
    pending.fallbackAsked = true;
    speakCurrent();
    return true;
  }

  logger.info('voice question remained ambiguous after one retry; keeping chat card active', {
    requestId: pending.request.id,
    header: question.header,
  });
  binding.dismiss(`voice-question:${pending.request.id}:${pending.index}:`);
  binding.speak({
    narrationId: `voice-question:${pending.request.id}:${pending.index}:card`,
    title: question.header,
    text: '我还是没能把回答唯一对应到选项。请在会话里的选项卡选择；不要替用户选择。',
  });
  advanceQueue();
  return true;
}
