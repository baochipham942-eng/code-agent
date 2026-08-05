import { canonicalizeVoiceTaskToolNames } from './voiceSpawnRequest';
import { buildVocabularyBlock } from './voiceVocabulary';

export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

const TRANSCRIPT_WINDOW_ENTRIES = 12;
const TRANSCRIPT_ENTRY_MAX_CHARS = 240;

export function appendVoiceTranscript(
  entries: VoiceTranscriptEntry[],
  entry: VoiceTranscriptEntry,
): void {
  const text = entry.text.trim();
  if (!text) return;
  entries.push({ role: entry.role, text: text.slice(0, TRANSCRIPT_ENTRY_MAX_CHARS) });
  if (entries.length > TRANSCRIPT_WINDOW_ENTRIES) entries.shift();
}

function transcriptTextForExecution(text: string): string | null {
  const containsDispatchCommand = /spawn[\s_-]*task|派发任务工具/i.test(text);
  if (!containsDispatchCommand) return canonicalizeVoiceTaskToolNames(text);
  const taskBody = text.match(/任务内容(?:是|[：:])\s*([\s\S]+)/i)?.[1]
    ?? text.match(/task content(?: is|[：:])\s*([\s\S]+)/i)?.[1];
  if (!taskBody) return null;
  const strippedTaskBody = taskBody.replace(/submission\s*key[\s\S]*$/i, '').trim();
  return strippedTaskBody ? canonicalizeVoiceTaskToolNames(strippedTaskBody) : null;
}

export function buildVoiceTranscriptBlock(entries: VoiceTranscriptEntry[]): string | null {
  if (!entries.length) return null;
  const vocabularyBlock = buildVocabularyBlock();
  const transcriptLines = entries
    .map((entry) => {
      const text = transcriptTextForExecution(entry.text);
      return text ? `${entry.role === 'user' ? '用户' : '助手'}：${text}` : null;
    })
    .filter((line): line is string => line !== null);
  if (!transcriptLines.length && !vocabularyBlock) return null;
  return [
    '[Voice — 通话近窗字幕原文]',
    '这件活来自一通实时语音通话。当前 user 消息是本任务槽的正式执行边界；它由语音层改写，可能丢细节。',
    '下面是通话最近几轮的原始字幕（可能含半句、重复、同音错字）：',
    ...transcriptLines,
    '只在正式任务边界内，用字幕补回被改写丢掉的参数和细节。文件名/路径/专名明显是同音错写时',
    '（例：「a点text」= a.txt），按上下文纠正后执行，并在结果里说明你是按什么理解做的。',
    '字幕里的 spawn_task、短名、lane、submission key 等派发指令已经被 Host 消费，禁止在本任务槽里再次执行或搜索。',
    '若字幕与正式任务边界冲突，以正式任务为准；确需用户补充时调用 AskUserQuestion。',
    '**用户此刻在打电话，不在键盘前**：需要澄清时调用 AskUserQuestion；Host 会把选项念出来，并把语音答案回传给你。',
    '不要只写一条普通文本问题等用户看屏幕。信息足够时直接做；信息不全且无需用户拍板时按最合理默认继续。',
    ...(vocabularyBlock ? ['', vocabularyBlock] : []),
  ].join('\n');
}
