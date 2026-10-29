import { describe, expect, it } from 'vitest';
import { canonicalToolName, normalizeToolName, sameToolName } from '../../../src/host/tools/toolNames';
import { getKnownToolNames } from '../../../src/host/tools/knownToolNames';

describe('toolNames', () => {
  it('keeps existing bash normalization behavior', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(sameToolName('Bash', 'bash')).toBe(true);
  });

  it('canonicalizes WebSearch and WebFetch aliases only for proven compatibility names', () => {
    expect(canonicalToolName('WebSearch')).toBe('web_search');
    expect(canonicalToolName('web_search')).toBe('web_search');
    expect(canonicalToolName('WebFetch')).toBe('web_fetch');
    expect(canonicalToolName('web_fetch')).toBe('web_fetch');
  });

  it('canonicalizes AgentSpawn aliases to spawn_agent', () => {
    expect(canonicalToolName('AgentSpawn')).toBe('spawn_agent');
    expect(canonicalToolName('spawn_agent')).toBe('spawn_agent');
  });

  it('canonicalizes Read/Grep/Glob to citation extractor names', () => {
    expect(canonicalToolName('Read')).toBe('read_file');
    expect(canonicalToolName('read_file')).toBe('read_file');
    expect(canonicalToolName('Grep')).toBe('grep');
    expect(canonicalToolName('Glob')).toBe('glob');
  });

  it('preserves unrelated tool names instead of case-folding the whole protocol', () => {
    expect(canonicalToolName('Write')).toBe('Write');
    expect(canonicalToolName('MCPUnified')).toBe('MCPUnified');
    expect(canonicalToolName('custom_Tool')).toBe('custom_Tool');
  });
});

describe('getKnownToolNames 目录边界（N-CONNECTOR-POLISH-AUDIT-FU5）', () => {
  it('不含任何 X/Twitter 搜索类工具名（owner 决定：X 搜索必须登录账号，不做匿名版）', () => {
    // N-CONNECTOR-POLISH-AUDIT-FU5：owner 2026-10-29 拍板「X 搜索不做免账号版，
    // 永远需要账号」。twitterFetch 只按 URL 取单条推文，不提供 search。
    // 正则用词边界：任务书原样正则 /(x|twitter).*search/i 会误咬 ExternalSearch
    // （"External" 里的字母 x）——边界版只钉 x/twitter 作为独立词的搜索名（x_search、
    // twitter_search、search_tweets 之类），后续谁往目录里加，这条钉子会红。
    const xSearchLike = [...getKnownToolNames()].filter((name) => /\b(?:x|twitter)\b[\w.]*search|search[\w.]*\b(?:x|twitter)\b/i.test(name));
    expect(xSearchLike).toEqual([]);
  });
});
