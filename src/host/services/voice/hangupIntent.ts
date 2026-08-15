// ============================================================================
// 挂断意图匹配（A1，2026-07-30）
//
// 用户说「挂断」，模型答「好的，通话结束」然后**不调 end_call**，电话继续开着——
// 四次真机复现，三轮 prompt 强化全败。所以这条闸是机制的：host 自己看用户的 final
// 字幕，命中就走既有的 end_call 收线链，不再等模型自觉。
//
// 取向是**高精度低召回**：误判把还在说话的人挂掉，漏判只是用户去点那个「挂断」按钮
// （= 现状）。所以词条必须落在**句尾**——「这个先这样处理然后继续」里的「先这样」
// 不是挂断意图。
// ============================================================================

import { VOICE_HANGUP_INTENT_PHRASES } from '../../../shared/constants/voice';

/** 句尾标点先剥掉：ASR 会给「挂断。」，也会给「挂断」。 */
const TRAILING_PUNCTUATION = /[\s。．.，,、！!？?~～…·]+$/;

/** 句尾语气词。剥掉再比一次，「先这样吧」「就这样了」才算数。 */
const TRAILING_PARTICLES = /[吧啦呀哦喔嗯呢咯喽了]+$/;

/** 词条前紧邻这些字就不是挂断：「别挂断」「先不要结束通话」「不能挂断」。 */
const NEGATIONS = ['不', '不要', '不用', '不想', '不能', '别', '没', '甭'];

function endsWithIntent(tail: string, phrase: string): boolean {
  if (!tail.endsWith(phrase)) return false;
  const before = tail.slice(0, tail.length - phrase.length);
  return !NEGATIONS.some((word) => before.endsWith(word));
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left === right) return true;

  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function hasNearMissSuffix(tail: string, phrase: string): boolean {
  // 两三个字允许一次编辑会把「再说」≈「再见」这类普通话误报；至少四字才有可用区分度。
  if (phrase.length < 4) return false;
  if (phrase.length > tail.length) return false;
  const candidate = tail.slice(-phrase.length);
  const before = tail.slice(0, -phrase.length);
  return !NEGATIONS.some((word) => before.endsWith(word))
    && editDistanceAtMostOne(candidate, phrase);
}

/** 这句话是不是在说「挂了吧」。只喂用户说的话，绝不喂 assistant 字幕。 */
export function detectHangupIntent(text: string): boolean {
  const tail = text.trim().replace(TRAILING_PUNCTUATION, '');
  if (!tail) return false;
  // 「挂了」「不聊了」本身就以「了」收尾，所以剥语气词前后各比一次。
  const bare = tail.replace(TRAILING_PARTICLES, '');
  return VOICE_HANGUP_INTENT_PHRASES.some(
    (phrase) => endsWithIntent(tail, phrase) || endsWithIntent(bare, phrase),
  );
}

/**
 * 正式词表的低置信盲区探针，只用于日志，不参与挂断。
 *
 * 它从同一份正式词表计算句尾的一次编辑距离近邻，不维护第二张「疑似挂断词」清单。
 * 因而新增正式词条会自动扩大可观测边界；否定前缀、句尾和语气词保护与正式闸一致。
 */
export function detectHangupIntentNearMiss(text: string): boolean {
  if (detectHangupIntent(text)) return false;
  const tail = text.trim().replace(TRAILING_PUNCTUATION, '');
  if (!tail) return false;
  const bare = tail.replace(TRAILING_PARTICLES, '');
  return VOICE_HANGUP_INTENT_PHRASES.some(
    (phrase) => hasNearMissSuffix(tail, phrase) || hasNearMissSuffix(bare, phrase),
  );
}
