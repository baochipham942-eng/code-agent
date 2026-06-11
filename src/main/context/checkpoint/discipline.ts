export type UserPromptIntentKind = 'commitment' | 'inspection' | 'keep';

const COMMITMENT_VERBS = [
  'implement',
  'write',
  'build',
  'fix',
  'run',
  'create',
  'refactor',
  'add',
  'remove',
  'update',
  'design',
  'debug',
] as const;

const INSPECTION_PHRASES = [
  'find',
  'list',
  'show',
  'print',
  'inspect',
  'tell',
  'describe',
  'explain',
  'what is',
  'why',
  'how does',
  'how do',
] as const;

const CHINESE_COMMITMENT_PATTERN = /开干|实现|修复|构建|创建|新增|删除|更新|重构|设计|调试|跑一下|执行/;
const CHINESE_INSPECTION_PATTERN = /查找|列出|展示|打印|检查|告诉我|描述|解释|是什么|为什么|怎么/;

function containsWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word.replace(/\s+/g, '\\s+')}([^a-z]|$)`, 'i').test(text);
}

export function classifyUserPromptIntent(prompt: string): UserPromptIntentKind {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return 'keep';

  if (COMMITMENT_VERBS.some((verb) => containsWord(normalized, verb)) || CHINESE_COMMITMENT_PATTERN.test(prompt)) {
    return 'commitment';
  }

  if (INSPECTION_PHRASES.some((phrase) => containsWord(normalized, phrase)) || CHINESE_INSPECTION_PATTERN.test(prompt)) {
    return 'inspection';
  }

  return 'keep';
}

export function shouldUpdateActiveIntent(prompt: string): boolean {
  return classifyUserPromptIntent(prompt) === 'commitment';
}

export function renderVerbatimBlockQuote(text: string, maxChars = 200): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return `> "${normalized}"`;
  }
  return [
    `> "${normalized.slice(0, maxChars)}..."`,
    '',
    `(Paraphrased: ${normalized.slice(0, 120).replace(/\s+/g, ' ')}...)`,
  ].join('\n');
}

