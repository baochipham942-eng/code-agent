import { describe, expect, it } from 'vitest';
import { canonicalToolName, normalizeToolName, sameToolName } from '../../../src/host/tools/toolNames';
import { getKnownToolNames, hasProtocolToolRegistry } from '../../../src/host/tools/knownToolNames';
// 触发 protocolRegistry 的模块副作用，让 getProtocolToolSchemas() 拿到真实注册表（host 同款 import）
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

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
  // N-CONNECTOR-POLISH-AUDIT-FU5：owner 2026-10-29 拍板「X 搜索不做免账号版，
  // 永远需要账号」。twitterFetch 只按 URL 取单条推文，不提供 search。
  // 判据按 token 化（返修 r1）：把名字按 `_`、`.`、`-`（含 `__`）和 camelCase 边界
  // 切开小写，同时出现 {x, twitter, tweet, tweets} 里的独立词和一个含 search 的
  // token 才算命中。首轮的 \b 词边界正则对 x_search/TwitterSearch/mcp__x__search
  // 全部漏判（_ 和驼峰字母都是 \w，\b 永不触发；tweets != twitter），钉子是空的。
  const X_WORDS = new Set(['x', 'twitter', 'tweet', 'tweets']);

  function tokenizeToolName(name: string): string[] {
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function isXSearchToolName(name: string): boolean {
    const tokens = tokenizeToolName(name);
    return tokens.some((token) => X_WORDS.has(token)) && tokens.some((token) => token.includes('search'));
  }

  it('协议注册表已装载（否则 getKnownToolNames 是残缺集合，钉子会假绿）', () => {
    // 与 tests/unit/agent/agentMdToolValidation.test.ts 同款真源引导：import 副作用
    // 装好 port，这里真调一次注册表再断言非空。
    getProtocolRegistry();
    expect(hasProtocolToolRegistry()).toBe(true);
    expect(getKnownToolNames().size).toBeGreaterThan(0);
    // 迟滞工具元数据也确实进了集合（twitter_fetch 按单条 URL 取推文，是目录既有成员）
    expect(getKnownToolNames().has('twitter_fetch')).toBe(true);
  });

  it('匹配器自检：钉得住各写法的 X 搜索名，不误咬既有搜索工具', () => {
    // 正向对照——这些写法必须全部命中，否则钉子退化为空转（返修 r1 的根因）
    for (const name of ['x_search', 'twitter_search', 'TwitterSearch', 'XSearch', 'search_x', 'search_tweets', 'mcp__x__search']) {
      expect(isXSearchToolName(name), `matcher 应命中 ${name}`).toBe(true);
    }
    // 负向对照——不带 X 语义的搜索名不能误伤
    for (const name of ['ExternalSearch', 'WebSearch', 'ToolSearch', 'web_search', 'desktop_activity_search', 'twitter_fetch']) {
      expect(isXSearchToolName(name), `matcher 不应命中 ${name}`).toBe(false);
    }
  });

  it('不含任何 X/Twitter 搜索类工具名（owner 决定：X 搜索必须登录账号，不做匿名版）', () => {
    const xSearchLike = [...getKnownToolNames()].filter(isXSearchToolName);
    expect(xSearchLike).toEqual([]);
  });
});
