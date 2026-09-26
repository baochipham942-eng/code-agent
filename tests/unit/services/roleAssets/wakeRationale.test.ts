import { describe, expect, it } from 'vitest';
import {
  formatHistoryWhySuffix,
  formatTopicPreferencePrompt,
  parseWakeRationale,
  sanitizeTopicList,
  stripWakeMarkup,
  topicExcludeHits,
} from '../../../../src/host/services/roleAssets/wakeRationale';

describe('parseWakeRationale', () => {
  it('extracts rationale and evidence', () => {
    const parsed = parseWakeRationale([
      '建议把周报改成自动生成。',
      '<rationale>履历里的周报已经连续两周没更新，值得现在提醒。</rationale>',
      '<evidence>roles/研究员/history.md · 周报.md</evidence>',
      '<decision>suggest</decision>',
    ].join('\n'));
    expect(parsed.missing).toBe(false);
    expect(parsed.rationale).toContain('连续两周没更新');
    expect(parsed.evidence).toBe('roles/研究员/history.md · 周报.md');
  });

  it('treats missing tags as rationale 缺失 without inventing text', () => {
    const parsed = parseWakeRationale('检查完毕。<decision>report</decision>');
    expect(parsed).toEqual({ missing: true });
  });

  it('treats empty rationale tag as missing', () => {
    const parsed = parseWakeRationale('<rationale>   </rationale><evidence></evidence><decision>suggest</decision>');
    expect(parsed.missing).toBe(true);
    expect(parsed.rationale).toBeUndefined();
    expect(parsed.evidence).toBeUndefined();
  });

  it('treats unclosed / malformed tags as missing', () => {
    expect(parseWakeRationale('<rationale>因为报告过期了<decision>suggest</decision>').missing).toBe(true);
    expect(parseWakeRationale('<rationale><rationale>nested</rationale>').rationale).toBe('<rationale>nested');
  });

  it('allows empty evidence when rationale is present', () => {
    const parsed = parseWakeRationale('<rationale>产物还在，需要你拍板下一步。</rationale><evidence></evidence>');
    expect(parsed.missing).toBe(false);
    expect(parsed.rationale).toContain('需要你拍板');
    expect(parsed.evidence).toBeUndefined();
  });
});

describe('topicExcludeHits', () => {
  it('matches case-insensitive substrings', () => {
    expect(topicExcludeHits('建议买一些 Crypto 理财', ['crypto', '八卦'])).toBe(true);
    expect(topicExcludeHits('项目进度正常', ['crypto'])).toBe(false);
    expect(topicExcludeHits('anything', [])).toBe(false);
    expect(topicExcludeHits('anything', undefined)).toBe(false);
  });
});

describe('sanitizeTopicList / prompt / markup', () => {
  it('trims, dedupes, and caps topic lists', () => {
    expect(sanitizeTopicList([' 项目进度 ', '项目进度', 'x'.repeat(80), '', 1])).toEqual([
      '项目进度',
      'x'.repeat(40),
    ]);
  });

  it('injects include and exclude into the wake prompt block', () => {
    const block = formatTopicPreferencePrompt({
      topicsInclude: ['项目进度'],
      topicsExclude: ['八卦'],
    });
    expect(block).toContain('用户想听：项目进度');
    expect(block).toContain('永远别提');
    expect(block).toContain('<decision>silence</decision>');
    expect(block).toContain('八卦');
  });

  it('strips wake markup from the user-facing summary', () => {
    const stripped = stripWakeMarkup('正文。<rationale>理由</rationale><evidence>依据</evidence><decision>suggest</decision>');
    expect(stripped).toBe('正文。');
  });

  it('records missing why in the history suffix', () => {
    expect(formatHistoryWhySuffix({ missing: true })).toBe(' | why: (missing)');
    expect(formatHistoryWhySuffix({ missing: false, rationale: '该跟进', evidence: 'history.md' }))
      .toBe(' | why: 该跟进 | evidence: history.md');
  });
});
