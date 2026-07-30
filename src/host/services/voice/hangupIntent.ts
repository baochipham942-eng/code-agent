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
