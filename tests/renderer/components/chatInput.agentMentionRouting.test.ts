import { describe, expect, it } from 'vitest';
import {
  applyAgentMentionSuggestion,
  buildDirectRoutingHint,
  buildDirectRoutingPlaceholder,
  getLeadingAgentMentionAutocomplete,
  getPreferredAgentMentionToken,
  isLeadingAgentMentionInput,
  parseLeadingAgentMentions,
  syncLeadingAgentMentions,
} from '../../../src/renderer/components/features/chat/ChatInput/agentMentionRouting';
import {
  buildNeoTopicMentionCandidates,
  NEO_TAG_MENTION_AGENT,
  NEO_TOPIC_MENTION_PREFIX,
  parseLeadingNeoTagInvocation,
} from '../../../src/renderer/components/features/chat/ChatInput/neoMentionRouting';

const agents = [
  { id: 'agent-builder', name: 'builder' },
  { id: 'agent-reviewer', name: 'reviewer' },
  { id: 'qa_lead', name: 'QA Lead' },
  { id: 'neo-agent', name: 'neo' },
];

describe('agent mention routing', () => {
  it('parses leading mentions and strips them from content', () => {
    expect(
      parseLeadingAgentMentions('@builder @reviewer 先看一下这轮改动', agents),
    ).toEqual({
      content: '先看一下这轮改动',
      targetAgentIds: ['agent-builder', 'agent-reviewer'],
    });
  });

  it('keeps @neo out of the composer mention panel entirely (2026-07-29 拍板砍入口)', () => {
    expect(parseLeadingAgentMentions('@neo 实现入口', agents)).toBeNull();
    // @neo 交互已从 composer 移除：mention 面板不再注入工作卡/续接候选，
    // 输入 @neo 没有任何候选（工作卡改从 Neo 协同页发起）。
    expect(getLeadingAgentMentionAutocomplete('@neo', agents)).toBeNull();
  });

  it('does not summon Neo for prefixes of neo', () => {
    expect(getLeadingAgentMentionAutocomplete('@ne', agents)).toBeNull();
    expect(getLeadingAgentMentionAutocomplete('@n', agents)).toBeNull();
  });

  it('bare @ 不再召唤 Neo（压文件 popup 的职责随 @neo 一并移除）', () => {
    const result = getLeadingAgentMentionAutocomplete('@', agents);
    // 裸 @ 只剩普通 agent 候选（别名为空集的不算），Neo 不在其中
    expect(result?.matches.some((m) => m.id === NEO_TAG_MENTION_AGENT.id) ?? false).toBe(false);
  });

  it('still routes @<filename> to file mention (query 非 neo 前缀不注入 Neo)', () => {
    // 打 @ 后接文件名前缀(非 n/ne/neo)时不召唤 Neo,文件 mention 照常
    const matches = getLeadingAgentMentionAutocomplete('@src', agents)?.matches ?? [];
    expect(matches).not.toContainEqual(NEO_TAG_MENTION_AGENT);
  });

  it('applies the Neo work-card mention as @neo ', () => {
    expect(applyAgentMentionSuggestion('@ne', NEO_TAG_MENTION_AGENT)).toBe('@neo ');
  });

  it('supports agent name aliases with spaces', () => {
    expect(
      parseLeadingAgentMentions('@qalead 帮我补测试', agents),
    ).toEqual({
      content: '帮我补测试',
      targetAgentIds: ['qa_lead'],
    });
  });

  it('does not parse mid-sentence mentions as routing directives', () => {
    expect(
      parseLeadingAgentMentions('先让 @reviewer 看测试风险', agents),
    ).toBeNull();
  });

  it('flags leading mention input so file autocomplete can yield', () => {
    expect(isLeadingAgentMentionInput('@', agents)).toBe(true);
    expect(isLeadingAgentMentionInput('@rev', agents)).toBe(true);
    expect(isLeadingAgentMentionInput('@builder @qa', agents)).toBe(true);
    expect(isLeadingAgentMentionInput('看看 @src/components', agents)).toBe(false);
  });

  it('returns empty content when the input only contains routing mentions', () => {
    expect(
      parseLeadingAgentMentions('@reviewer @builder', agents),
    ).toEqual({
      content: '',
      targetAgentIds: ['agent-reviewer', 'agent-builder'],
    });
  });

  it('returns agent mention autocomplete candidates for the trailing token', () => {
    expect(
      getLeadingAgentMentionAutocomplete('@builder @re', agents),
    ).toEqual({
      query: 're',
      matches: [{ id: 'agent-reviewer', name: 'reviewer' }],
    });
  });

  it('applies selected agent mention into the trailing token', () => {
    expect(
      applyAgentMentionSuggestion('@builder @re', agents[1]!),
    ).toBe('@builder @reviewer ');
  });

  it('normalizes the preferred mention token from agent name', () => {
    expect(getPreferredAgentMentionToken(agents[2]!)).toBe('qa-lead');
  });

  it('builds a direct-routing hint for selected agents', () => {
    expect(
      buildDirectRoutingHint([agents[1]!], agents),
    ).toContain('这条消息会发给 reviewer');
  });

  it('builds a direct-routing placeholder for empty direct mode', () => {
    expect(
      buildDirectRoutingPlaceholder([], agents),
    ).toBe('Direct 模式：输入 @builder 开始');
  });

  it('syncs chip-selected agents back into the leading mention prefix', () => {
    expect(
      syncLeadingAgentMentions('先看一下这轮改动', [agents[1]!], agents),
    ).toBe('@reviewer 先看一下这轮改动');
  });

  it('replaces existing leading mentions when chip selection changes', () => {
    expect(
      syncLeadingAgentMentions('@builder 先看一下这轮改动', [agents[1]!], agents),
    ).toBe('@reviewer 先看一下这轮改动');
  });

  it('removes leading mentions when chip selection becomes empty', () => {
    expect(
      syncLeadingAgentMentions('@reviewer 先看一下这轮改动', [], agents),
    ).toBe('先看一下这轮改动');
  });
});

describe('neo topic mention candidates (ADR-035)', () => {
  const topics = [
    { workCardId: 'nwc_1', title: '整理竞品报告', status: 'completed', updatedAt: 30 },
    { workCardId: 'nwc_2', title: '梳理定价', status: 'in_result_review', updatedAt: 20 },
    { workCardId: 'nwc_3', title: '已归档的活', status: 'archived', updatedAt: 99 },
    { workCardId: 'nwc_4', title: '已取消的活', status: 'cancelled', updatedAt: 98 },
  ];

  it('builds candidates from active topics, newest first, closed excluded', () => {
    const candidates = buildNeoTopicMentionCandidates(topics);
    expect(candidates.map((c) => c.id)).toEqual([
      `${NEO_TOPIC_MENTION_PREFIX}nwc_1`,
      `${NEO_TOPIC_MENTION_PREFIX}nwc_2`,
    ]);
    // 主文案直接带 topic 标题（与「Neo 工作卡」首行一眼可辨），右侧只标「续接」
    expect(candidates[0].name).toBe('Neo · 整理竞品报告');
    expect(candidates[0].role).toBe('续接');
  });

  it('Neo 工作卡候选主文案与说明性 role 可辨', () => {
    expect(NEO_TAG_MENTION_AGENT.name).toBe('Neo 工作卡');
    expect(NEO_TAG_MENTION_AGENT.role).toBe('呼叫 Neo 开一张新工作卡');
  });

  it('caps candidates at 5 most recently active', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      workCardId: `nwc_m${i}`,
      title: `topic ${i}`,
      status: 'completed',
      updatedAt: i,
    }));
    const candidates = buildNeoTopicMentionCandidates(many);
    expect(candidates).toHaveLength(5);
    expect(candidates[0].id).toBe(`${NEO_TOPIC_MENTION_PREFIX}nwc_m7`);
  });

  it('topic candidates 不再进 @ 面板（@neo 入口已砍）', () => {
    const autocomplete = getLeadingAgentMentionAutocomplete('@neo', agents, buildNeoTopicMentionCandidates(topics));
    expect(autocomplete).toBeNull();
  });

  it('keeps topic candidates out when query does not summon Neo', () => {
    const matches = getLeadingAgentMentionAutocomplete('@src', agents, buildNeoTopicMentionCandidates(topics))?.matches ?? [];
    expect(matches.some((m) => m.id.startsWith(NEO_TOPIC_MENTION_PREFIX))).toBe(false);
  });
});
