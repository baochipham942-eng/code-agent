// ============================================================================
// 口述词表 textarea → settings.voice.vocabulary 的解析（批 X4）
//
// 设置页一行一个词条；这里统一 split / trim / 去空行 / 去重 / 截上限，
// 纯函数，单测钉住。host 注入前的二次清洗在 host 侧 voiceVocabulary.ts，
// 两边输入不同（textarea 原始文本 vs 已落盘的数组），不共用实现。
// ============================================================================

import { VOICE_VOCABULARY_MAX_ENTRIES } from '@shared/constants/voice';

export interface VoiceVocabularyParseResult {
  /** 去空去重后的有效词条，最多 VOICE_VOCABULARY_MAX_ENTRIES 条。 */
  entries: string[];
  /** 因超出上限被丢弃的条数（> 0 时 UI 要提示「只保留前 N 条」）。 */
  overflowCount: number;
}

export function parseVoiceVocabularyInput(text: string): VoiceVocabularyParseResult {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const line of text.split('\n')) {
    const term = line.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    valid.push(term);
  }
  return {
    entries: valid.slice(0, VOICE_VOCABULARY_MAX_ENTRIES),
    overflowCount: Math.max(0, valid.length - VOICE_VOCABULARY_MAX_ENTRIES),
  };
}
