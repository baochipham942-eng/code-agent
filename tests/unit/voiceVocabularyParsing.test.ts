// 批 X4：口述词表 textarea 解析——split / trim / 去空行 / 去重 / 截上限。
import { describe, expect, it } from 'vitest';
import { VOICE_VOCABULARY_MAX_ENTRIES } from '../../src/shared/constants/voice';
import { parseVoiceVocabularyInput } from '../../src/renderer/components/features/voice/voiceVocabularyParsing';

describe('parseVoiceVocabularyInput', () => {
  it('按行 split、trim、去空行', () => {
    const result = parseVoiceVocabularyInput('  a.txt  \n\nNeo\n   \nworktree\n');
    expect(result.entries).toEqual(['a.txt', 'Neo', 'worktree']);
    expect(result.overflowCount).toBe(0);
  });

  it('去重：完全相同的词条只保留第一次出现', () => {
    const result = parseVoiceVocabularyInput('Neo\nworktree\n Neo \nneo\n');
    // 「neo」与「Neo」大小写不同，是不同词条（拼写纠正场景大小写敏感）
    expect(result.entries).toEqual(['Neo', 'worktree', 'neo']);
  });

  it('空输入得到空词表', () => {
    expect(parseVoiceVocabularyInput('').entries).toEqual([]);
    expect(parseVoiceVocabularyInput('\n \n\t\n').entries).toEqual([]);
  });

  it('超过上限只保留前 N 条并报告溢出条数', () => {
    const text = Array.from({ length: VOICE_VOCABULARY_MAX_ENTRIES + 5 }, (_, i) => `term-${i}`).join('\n');
    const result = parseVoiceVocabularyInput(text);
    expect(result.entries).toHaveLength(VOICE_VOCABULARY_MAX_ENTRIES);
    expect(result.entries.at(-1)).toBe(`term-${VOICE_VOCABULARY_MAX_ENTRIES - 1}`);
    expect(result.overflowCount).toBe(5);
  });

  it('重复行不计入溢出：先完整去重再截上限', () => {
    const text = Array.from({ length: VOICE_VOCABULARY_MAX_ENTRIES + 20 }, () => 'same-term').join('\n');
    const result = parseVoiceVocabularyInput(text);
    expect(result.entries).toEqual(['same-term']);
    expect(result.overflowCount).toBe(0);
  });
});
