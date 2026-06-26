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

// 词边界排除标识符字符（_ - . 数字）：`run_eval.sh`、`build-switch.txt` 不命中动词（audit C-M2）
const IDENTIFIER_CHARS = 'a-z0-9_.-';

function firstWordIndex(text: string, word: string): number {
  const pattern = new RegExp(
    `(^|[^${IDENTIFIER_CHARS}])(${word.replace(/\s+/g, '\\s+')})(?=[^${IDENTIFIER_CHARS}]|$)`,
    'i',
  );
  const match = pattern.exec(text);
  return match ? match.index + match[1].length : -1;
}

function earliestMatchIndex(text: string, prompt: string, words: readonly string[], chinese: RegExp): number {
  const indices = words
    .map((word) => firstWordIndex(text, word))
    .filter((index) => index >= 0);
  const chineseMatch = chinese.exec(prompt);
  if (chineseMatch) indices.push(chineseMatch.index);
  return indices.length > 0 ? Math.min(...indices) : -1;
}

export function classifyUserPromptIntent(prompt: string): UserPromptIntentKind {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return 'keep';

  // 同时命中 commitment 与 inspection 时按首次出现位置裁决（audit C-M2）：
  // "explain ... before we run it" → inspection；"fix the bug, then show me" → commitment
  const commitmentIndex = earliestMatchIndex(normalized, prompt, COMMITMENT_VERBS, CHINESE_COMMITMENT_PATTERN);
  const inspectionIndex = earliestMatchIndex(normalized, prompt, INSPECTION_PHRASES, CHINESE_INSPECTION_PATTERN);

  if (commitmentIndex >= 0 && (inspectionIndex < 0 || commitmentIndex <= inspectionIndex)) {
    return 'commitment';
  }
  if (inspectionIndex >= 0) {
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

