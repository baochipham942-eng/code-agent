import {
  VOICE_VOCABULARY_MAX_ENTRIES,
  VOICE_VOCABULARY_MAX_TERM_LENGTH,
} from '../../../shared/constants/voice';
import { getConfigService } from '../core/configService';

/** 读取并清洗口述词表；设置不可用时不影响通话与派活。 */
export function getVoiceVocabulary(): string[] {
  try {
    const configured = getConfigService().getSettings().voice?.vocabulary;
    if (!Array.isArray(configured)) return [];

    const vocabulary: string[] = [];
    const seen = new Set<string>();
    for (const rawTerm of configured) {
      if (typeof rawTerm !== 'string') continue;
      const term = rawTerm.trim();
      if (!term || term.length > VOICE_VOCABULARY_MAX_TERM_LENGTH || seen.has(term)) continue;
      seen.add(term);
      vocabulary.push(term);
      if (vocabulary.length >= VOICE_VOCABULARY_MAX_ENTRIES) break;
    }
    return vocabulary;
  } catch {
    return [];
  }
}

/** 空词表不生成占位块，避免无效 instructions 污染通话与执行上下文。 */
export function buildVocabularyBlock(): string {
  const vocabulary = getVoiceVocabulary();
  if (!vocabulary.length) return '';
  return [
    '[口述词表]',
    ...vocabulary.map((term) => `- ${term}`),
    '语音转写里出现与上述词条发音相近或形近的串（如「a点text」之于「a.txt」）时，按词表拼写理解；派活、建文件、复述时一律用词表拼写。',
  ].join('\n');
}
