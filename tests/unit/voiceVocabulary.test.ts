import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_VOCABULARY_MAX_ENTRIES,
  VOICE_VOCABULARY_MAX_TERM_LENGTH,
} from '../../src/shared/constants/voice';

const config = vi.hoisted(() => ({
  getSettings: vi.fn<() => unknown>(),
}));

vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: config.getSettings }),
}));

const {
  buildVocabularyBlock,
  getVoiceVocabulary,
} = await import('../../src/host/services/voice/voiceVocabulary');

describe('口述词表读取与清洗', () => {
  beforeEach(() => {
    config.getSettings.mockReset();
    config.getSettings.mockReturnValue({});
  });

  it('trim、去空并按首次出现顺序去重', () => {
    config.getSettings.mockReturnValue({
      voice: { vocabulary: ['  a.txt  ', '', '   ', 'Neo', 'a.txt', ' Neo '] },
    });

    expect(getVoiceVocabulary()).toEqual(['a.txt', 'Neo']);
  });

  it('丢弃超过单词条长度上限的内容', () => {
    const accepted = 'a'.repeat(VOICE_VOCABULARY_MAX_TERM_LENGTH);
    const tooLong = 'b'.repeat(VOICE_VOCABULARY_MAX_TERM_LENGTH + 1);
    config.getSettings.mockReturnValue({ voice: { vocabulary: [tooLong, accepted] } });

    expect(getVoiceVocabulary()).toEqual([accepted]);
  });

  it('有效词条超过总量上限时截断', () => {
    const configured = Array.from(
      { length: VOICE_VOCABULARY_MAX_ENTRIES + 5 },
      (_, index) => `term-${index}`,
    );
    config.getSettings.mockReturnValue({ voice: { vocabulary: configured } });

    const vocabulary = getVoiceVocabulary();
    expect(vocabulary).toHaveLength(VOICE_VOCABULARY_MAX_ENTRIES);
    expect(vocabulary.at(-1)).toBe(`term-${VOICE_VOCABULARY_MAX_ENTRIES - 1}`);
    expect(vocabulary).not.toContain(`term-${VOICE_VOCABULARY_MAX_ENTRIES}`);
  });

  it('settings 读取异常时返回空词表', () => {
    config.getSettings.mockImplementation(() => {
      throw new Error('settings unavailable');
    });

    expect(getVoiceVocabulary()).toEqual([]);
    expect(buildVocabularyBlock()).toBe('');
  });

  it('非空词表生成拼写纠正规则，空词表不生成占位块', () => {
    config.getSettings.mockReturnValue({ voice: { vocabulary: ['a.txt', 'Codex'] } });

    expect(buildVocabularyBlock()).toBe([
      '[口述词表]',
      '- a.txt',
      '- Codex',
      '语音转写里出现与上述词条发音相近或形近的串（如「a点text」之于「a.txt」）时，按词表拼写理解；派活、建文件、复述时一律用词表拼写。',
    ].join('\n'));

    config.getSettings.mockReturnValue({ voice: { vocabulary: [] } });
    expect(buildVocabularyBlock()).toBe('');
  });
});
