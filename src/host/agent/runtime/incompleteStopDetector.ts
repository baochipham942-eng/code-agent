import type { ModelResponse } from '../../agent/loopTypes';

const COMPLETE_TEXT_ENDING = /[。！？.!?…）」』】》\]"']$/;
const INCOMPLETE_TEXT_ENDING = /[，、：；,;:]$/;
const INCOMPLETE_CHINESE_TAILS = [
  '把',
  '把这',
  '把这个',
  '把这些',
  '将',
  '被',
  '对',
  '在',
  '从',
  '和',
  '或',
  '但',
  '因为',
  '所以',
  '包括',
  '比如',
  '通过',
  '需要',
  '可以',
  '这个',
  '这些',
  '这',
];

export function isLikelyIncompleteStopText(response: ModelResponse): boolean {
  if (response.type !== 'text' || !response.content || response.truncated) {
    return false;
  }

  const stopReason = response.finishReason ?? 'stop';
  if (stopReason !== 'stop' && stopReason !== 'end_turn') {
    return false;
  }

  const content = response.content.trim();
  if (content.length < 40 || COMPLETE_TEXT_ENDING.test(content)) {
    return false;
  }

  const codeFenceCount = content.match(/```/g)?.length ?? 0;
  if (codeFenceCount % 2 === 1) {
    return true;
  }

  if (INCOMPLETE_TEXT_ENDING.test(content)) {
    return true;
  }

  const tail = content.slice(-18);
  return INCOMPLETE_CHINESE_TAILS.some((candidate) => tail.endsWith(candidate));
}
