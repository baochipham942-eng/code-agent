// ============================================================================
// contextComposition — bySource 当前态构成算法（N-CTXCURRENT）
// 语义：每桶 = 「当前装进模型的构成」，从消息列表 + systemPrompt + 挂载 skills 重算。
// 反向变异承重：ContextHealthService.update() 不再调用 computeSourceBreakdown 时，
// 本文件的服务级用例（底部 describe）必须红。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompactionBlock } from '../../../src/shared/contract/message';
import type { ToolCall } from '../../../src/shared/contract';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import {
  computeSourceBreakdown,
  compositionMessagesTokens,
  compositionToolResultsTokens,
  type CompositionMessage,
} from '../../../src/host/context/contextComposition';

vi.mock('../../../src/host/session/sessionStateManager', () => ({
  getSessionStateManager: () => ({ updateContextHealth: vi.fn() }),
}));

import { ContextHealthService } from '../../../src/host/context/contextHealthService';

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

function toolResultMessage(
  results: Array<{ toolCallId: string; output?: string; error?: string }>,
): CompositionMessage {
  return {
    role: 'tool',
    content: JSON.stringify(results),
    toolResults: results,
  };
}

const AGENTS_BLOCK = [
  '<agents-instructions>',
  'The following AGENTS.md instructions were discovered in the project:',
  '',
  '# AGENTS.md',
  '',
  '构建前先跑 npm run typecheck，提交前跑全量测试。',
  '</agents-instructions>',
].join('\n');

describe('computeSourceBreakdown — 当前态构成', () => {
  it('空会话：来源桶归零，conversation 只剩估算器的会话基线开销', () => {
    const bs = computeSourceBreakdown([], '');
    expect(bs.rules).toBe(0);
    expect(bs.skills).toEqual({});
    expect(bs.mcp).toEqual({});
    expect(bs.subagents).toEqual({});
    expect(bs.fileReads).toBe(0);
    expect(bs.summary).toBe(0);
    // estimateConversationTokens 对空会话也有固定 priming 开销（原有口径，非本单引入）
    expect(bs.conversation).toBe(compositionMessagesTokens([]));
  });

  it('MCP 结果：mcp__server__tool（现行）与 mcp_server_tool（legacy）都按 server 归桶', () => {
    const messages: CompositionMessage[] = [
      { role: 'user', content: '查一下 github issue' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          toolCall('c1', 'mcp__github__list_issues', { query: 'bug' }),
          toolCall('c2', 'mcp_slack_send_message', { channel: 'general' }),
        ],
      },
      toolResultMessage([
        { toolCallId: 'c1', output: 'issue 列表内容'.repeat(20) },
        { toolCallId: 'c2', output: '发送成功' },
      ]),
    ];

    const bs = computeSourceBreakdown(messages, '');

    expect(bs.mcp.github).toBeGreaterThan(0);
    expect(bs.mcp.slack).toBeGreaterThan(0);
    // 结果内容计入对应 server 桶
    expect(bs.mcp.github!).toBeGreaterThanOrEqual(estimateTokens('issue 列表内容'.repeat(20)));
    // conversation 被对应扣减
    const base = compositionMessagesTokens(messages) + compositionToolResultsTokens(messages);
    expect(bs.conversation).toBeLessThan(base);
  });

  it('Read 类：Read / read_file 变体都进 fileReads 桶', () => {
    const fileContent = 'export const answer = 42;\n'.repeat(30);
    const messages: CompositionMessage[] = [
      { role: 'user', content: '读两个文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          toolCall('r1', 'Read', { file_path: '/a.ts' }),
          toolCall('r2', 'read_file', { path: '/b.ts' }),
        ],
      },
      toolResultMessage([
        { toolCallId: 'r1', output: fileContent },
        { toolCallId: 'r2', output: fileContent },
      ]),
    ];

    const bs = computeSourceBreakdown(messages, '');

    // 两次读取的结果内容都进 fileReads
    expect(bs.fileReads).toBeGreaterThanOrEqual(estimateTokens(fileContent) * 2);
    expect(bs.conversation).toBeGreaterThanOrEqual(0);
  });

  it('压缩摘要：compaction 标记消息进 summary，conversation 扣减', () => {
    const summaryContent = '## Current State\n压缩前的对话摘要。';
    const compaction: CompactionBlock = {
      type: 'compaction',
      content: summaryContent,
      timestamp: 1,
      compactedMessageCount: 5,
      compactedTokenCount: 1000,
    };
    const messages: CompositionMessage[] = [
      { role: 'system', content: summaryContent, compaction },
      { role: 'user', content: '继续刚才的任务' },
    ];

    const bs = computeSourceBreakdown(messages, '');

    expect(bs.summary).toBe(estimateTokens(summaryContent));
    const base = compositionMessagesTokens(messages) + compositionToolResultsTokens(messages);
    expect(bs.conversation).toBe(Math.max(0, base - bs.summary));
  });

  it('挂载 skill + AGENTS 注入：skills 走 hints，rules 从 system 消息定位 <agents-instructions>', () => {
    const messages: CompositionMessage[] = [
      { role: 'system', content: `<session-start-hook>\n${AGENTS_BLOCK}\n</session-start-hook>` },
      { role: 'user', content: '帮我写个 commit' },
    ];

    const bs = computeSourceBreakdown(messages, '', {
      skills: [
        { name: 'commit', tokens: 120 },
        { name: 'review', tokens: 0 }, // 0 值不占位
      ],
    });

    expect(bs.rules).toBe(estimateTokens(AGENTS_BLOCK));
    expect(bs.skills).toEqual({ commit: 120 });
  });

  it('rules 兜底：消息里没有时从 systemPrompt 定位 <agents-instructions>', () => {
    const messages: CompositionMessage[] = [{ role: 'user', content: 'hi' }];
    const systemPrompt = `你是 Neo。\n\n${AGENTS_BLOCK}\n\n其他内容。`;

    const bs = computeSourceBreakdown(messages, systemPrompt);
    expect(bs.rules).toBe(estimateTokens(AGENTS_BLOCK));
  });

  it('子代理：Task / spawn_agent 按子代理名归桶（参数取 subagent_type/agentId）', () => {
    const messages: CompositionMessage[] = [
      { role: 'user', content: '派两个子代理' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          toolCall('t1', 'Task', { subagent_type: 'Explore', prompt: '找一下入口' }),
          toolCall('t2', 'spawn_agent', { agentId: 'researcher', prompt: '调研竞品' }),
        ],
      },
      toolResultMessage([
        { toolCallId: 't1', output: '探索结果'.repeat(30) },
        { toolCallId: 't2', output: '调研报告'.repeat(30) },
      ]),
    ];

    const bs = computeSourceBreakdown(messages, '');

    expect(bs.subagents.Explore).toBeGreaterThan(0);
    expect(bs.subagents.researcher).toBeGreaterThan(0);
  });

  it('无法归因的 tool 结果留在 conversation（不塞进来源桶）', () => {
    const messages: CompositionMessage[] = [
      { role: 'user', content: '跑个命令' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [toolCall('b1', 'Bash', { command: 'ls' })],
      },
      toolResultMessage([{ toolCallId: 'b1', output: 'file-a\nfile-b' }]),
    ];

    const bs = computeSourceBreakdown(messages, '');

    expect(bs.mcp).toEqual({});
    expect(bs.fileReads).toBe(0);
    // bash 调用与结果不属于任何来源桶，全部留在 conversation
    const base = compositionMessagesTokens(messages) + compositionToolResultsTokens(messages);
    expect(bs.conversation).toBe(base);
  });
});

describe('ContextHealthService.update — 构成函数接入（反向变异承重）', () => {
  let service: ContextHealthService;

  beforeEach(() => {
    service = new ContextHealthService();
  });

  it('update() 每轮用构成函数重算 bySource：历史里的 Read 结果进 fileReads 桶', () => {
    const fileContent = 'const x = 1;\n'.repeat(40);
    const health = service.update('cur1', [
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [toolCall('r1', 'Read', { file_path: '/a.ts' })],
      },
      toolResultMessage([{ toolCallId: 'r1', output: fileContent }]),
    ], '', 'kimi-k2.5');

    const bs = health.breakdown.bySource!;
    expect(bs.fileReads).toBeGreaterThanOrEqual(estimateTokens(fileContent));
    expect(bs.conversation).toBeGreaterThanOrEqual(0);
  });

  it('当前态语义：消息换掉后来源桶随之消失（不是累计账）', () => {
    const fileContent = 'const x = 1;\n'.repeat(40);
    service.update('cur2', [
      {
        role: 'assistant',
        content: '',
        toolCalls: [toolCall('r1', 'Read', { file_path: '/a.ts' })],
      },
      toolResultMessage([{ toolCallId: 'r1', output: fileContent }]),
    ], '', 'kimi-k2.5');

    // 压缩后消息列表不含 Read 调用，fileReads 必须归零——累计账语义下会残留
    const after = service.update('cur2', [{ role: 'user', content: '继续' }], '', 'kimi-k2.5');
    expect(after.breakdown.bySource!.fileReads).toBe(0);
  });

  it('挂载 skills 经 sourceHints 进 skills 桶', () => {
    const health = service.update(
      'cur3',
      [{ role: 'user', content: 'hi' }],
      '',
      'kimi-k2.5',
      undefined,
      undefined,
      undefined,
      undefined,
      { skills: [{ name: 'commit', tokens: 88 }] },
    );
    expect(health.breakdown.bySource!.skills).toEqual({ commit: 88 });
  });
});
