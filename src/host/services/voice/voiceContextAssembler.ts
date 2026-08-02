// ============================================================================
// VoiceContextAssembler（方案 §6.5，批 H）
//
// 把「用户此刻在看什么」拼成 instructions 的 [Context — Focus] 段。
// 焦点变化时增量 session.update——只重发 instructions，不重发整份 session。
//
// 为什么字段是 view/filePath/unsaved/selectedElement 而不是方案里写的
// 「当前文件 / 选区 / diff」：Neo 不是 IDE，它没有编辑器文本选区、也没有 diff 视图。
// 照抄 IDE 词汇的结果是通话 brain 一本正经地聊不存在的东西——比没有上下文更糟。
// ============================================================================

import type { VoiceFocusContext } from '../../../shared/contract/voice';
import type { VoiceLiveSettings } from '../../../shared/contract/settings';
import type { Message } from '../../../shared/contract/message';
import type { SessionState } from '../../task';
import { buildVocabularyBlock } from './voiceVocabulary';
import { buildSpeechPaceDirective } from './voiceRouting';

/**
 * 10 条能覆盖约 5 轮来回，足够回答“刚才说到哪了”，又不会让每次拨号固定携带整通历史。
 * 取工单允许的 8~12 中值，给用户和助手两边的 final 留相同预算。
 */
export const VOICE_CONTINUITY_TRANSCRIPT_LIMIT = 10;

/**
 * 两小时覆盖短暂离开、午休后续聊；再久更像一次新话题。即使不足两小时，跨自然日也不注入。
 */
export const VOICE_CONTINUITY_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

/** 单条超出该长度时改用完整句子的摘录摘要，不能把半句话塞给通话模型。 */
export const VOICE_CONTINUITY_TRANSCRIPT_CHAR_LIMIT = 240;

export interface VoiceContinuityContext {
  neoSessionId: string;
  sourceSessionId: string;
  messages: Message[];
  taskState: SessionState;
  now: number;
}

export interface VoiceInstructionContext {
  continuity?: VoiceContinuityContext | null;
  /** Phase 3 才会有真实设置契约；本单只保留 instructions 形状，调用方固定传 false。 */
  screenContextEnabled?: boolean;
  /**
   * 通话语速（T6/§4.1）。**必须每次现读设置再传进来**，不能烤进建连时的快照——
   * 用户在通话中改语速要靠这条即时生效（refreshVoiceInstructions 走的就是这条路）。
   */
  speechRate?: VoiceLiveSettings['speechRate'];
}

const VIEW_LABEL: Record<string, string> = {
  overview: '概览',
  files: '文件列表',
  browser: '浏览器',
  'design-canvas': '设计画布',
};

function describeView(view: string): string {
  if (view.startsWith('preview:')) return `文件预览（${view.slice('preview:'.length)}）`;
  return VIEW_LABEL[view] ?? view;
}

/** 空焦点返回空串——没东西可说时不要塞一段「（无）」进 instructions。 */
export function buildFocusBlock(focus: VoiceFocusContext | null): string {
  if (!focus) return '';
  const lines: string[] = [];
  if (focus.view) lines.push(`- 右栏正在看：${describeView(focus.view)}`);
  if (focus.filePath) lines.push(`- 当前文件：${focus.filePath}${focus.unsaved ? '（有未保存改动）' : ''}`);
  if (focus.selectedElement) lines.push(`- 选中的元素：${focus.selectedElement}`);
  if (!lines.length) return '';
  return [
    '[Context — Focus]',
    ...lines,
    '用户说「这个」「这里」「当前这个文件」时，多半指的就是上面这些。不确定就问一句，别猜。',
  ].join('\n');
}

/** Phase 3 占位：只声明能请求看屏，不暗示当前已经取得屏幕内容。 */
export function buildScreenContextBlock(enabled: boolean): string {
  if (!enabled) return '';
  return [
    '[Context — Screen]',
    '用户说“这个”“屏幕上”时，我可以请用户允许我看屏幕；在真正看到之前不猜。',
  ].join('\n');
}

function sameLocalDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/**
 * 超长字幕只摘完整句子。单个句子自身已经超限时不截正文，改给一条诚实的概括和回看指路。
 */
function summarizeTranscript(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= VOICE_CONTINUITY_TRANSCRIPT_CHAR_LIMIT) return normalized;
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g) ?? [];
  const selected: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.length > VOICE_CONTINUITY_TRANSCRIPT_CHAR_LIMIT) continue;
    if (used + trimmed.length > VOICE_CONTINUITY_TRANSCRIPT_CHAR_LIMIT) break;
    selected.push(trimmed);
    used += trimmed.length;
  }
  if (!selected.length) return '摘要：这一轮有一段较长的连续表述，逐字内容保留在会话记录里。';
  return `摘要：${selected.join('')}（其余内容保留在会话记录里）`;
}

function taskStateLabel(state: SessionState['status']): string | null {
  switch (state) {
    case 'queued': return '等待开始';
    case 'running': return '正在处理';
    case 'paused': return '暂停中';
    case 'cancelling': return '正在取消';
    case 'error': return '执行出错，结果尚未落地';
    case 'idle': return null;
  }
}

function buildUnsettledWorkLines(messages: Message[], taskState: SessionState): string[] {
  const stateLabel = taskStateLabel(taskState.status);
  if (!stateLabel) return [];

  const settledIds = new Set<string>();
  for (const message of messages) {
    const failureId = message.metadata?.voiceWorkFailure?.workItemId;
    const settledId = message.metadata?.voiceWorkSettled?.workItemId;
    if (failureId) settledIds.add(failureId);
    if (settledId) settledIds.add(settledId);
  }

  const pending = new Map<string, string>();
  for (const message of messages) {
    const dispatch = message.metadata?.voiceDispatch;
    if (!dispatch?.workItemId || settledIds.has(dispatch.workItemId)) continue;
    pending.set(dispatch.workItemId, dispatch.title);
  }
  return [...pending.values()].slice(-3).map((title) => `- 未落地工作“${title}”：${stateLabel}`);
}

/** 不满足同会话、时限、同一天、有历史四道门时，严格返回空串。 */
export function buildRecentVoiceBlock(context: VoiceContinuityContext | null): string {
  if (!context || context.neoSessionId !== context.sourceSessionId) return '';
  const summaries = context.messages.filter((message) => message.metadata?.voiceCallSummary);
  const previousCall = summaries.at(-1)?.metadata?.voiceCallSummary;
  if (!previousCall) return '';
  const age = context.now - previousCall.endedAt;
  if (age < 0 || age >= VOICE_CONTINUITY_MAX_AGE_MS || !sameLocalDay(context.now, previousCall.endedAt)) return '';

  const transcripts = context.messages
    .filter((message) => (
      message.metadata?.source === 'voice'
      && (message.role === 'user' || message.role === 'assistant')
      && message.timestamp >= previousCall.startedAt
      && message.timestamp <= previousCall.endedAt
      && message.content.trim()
    ))
    .slice(-VOICE_CONTINUITY_TRANSCRIPT_LIMIT);
  if (!transcripts.length) return '';

  const transcriptLines = transcripts.map((message) => (
    `- ${message.role === 'user' ? '用户' : '我'}：${summarizeTranscript(message.content)}`
  ));
  const workLines = buildUnsettledWorkLines(context.messages, context.taskState);
  return [
    '[Context — Recent voice]',
    '这是上一通电话的结尾。先静默接上这些内容，不要主动开口复述，等用户说话。',
    ...transcriptLines,
    ...workLines,
  ].join('\n');
}

/** 人设 + 语速 + 焦点 + 屏幕占位 + 通话连续性 + 口述词表。空块不留标题或空行。 */
export function composeVoiceInstructions(
  persona: string,
  focus: VoiceFocusContext | null,
  context: VoiceInstructionContext = {},
): string {
  const blocks = [
    // 语速是「怎么说话」的约束，属人设范畴，所以紧跟 persona 排在所有 Context 段之前。
    buildSpeechPaceDirective(context.speechRate),
    buildFocusBlock(focus),
    buildScreenContextBlock(context.screenContextEnabled === true),
    buildRecentVoiceBlock(context.continuity ?? null),
    buildVocabularyBlock(),
  ].filter(Boolean);
  return [persona, ...blocks].join('\n\n');
}

/** 焦点有没有实质变化。没变就不发 session.update——上游每次刷新都有代价。 */
export function focusChanged(a: VoiceFocusContext | null, b: VoiceFocusContext | null): boolean {
  return buildFocusBlock(a) !== buildFocusBlock(b);
}
