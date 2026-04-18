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

const agents = [
  { id: 'agent-builder', name: 'builder' },
  { id: 'agent-reviewer', name: 'reviewer' },
  { id: 'qa_lead', name: 'QA Lead' },
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
