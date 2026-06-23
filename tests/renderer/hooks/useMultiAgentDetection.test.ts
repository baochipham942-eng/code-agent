import { describe, it, expect } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import {
  extractToolCalls,
  isMultiAgentToolCall,
  extractAgentName,
  detectPattern,
  extractActiveAgents,
} from '../../../src/renderer/hooks/useMultiAgentDetection';

// useMultiAgentDetection 从会话 toolCall 序列推断多 Agent 协作形态
// （single/parallel/hierarchical/sequential）。这里直接测其纯检测函数，
// 覆盖各启发式分支与 agent 名提取的多种字段来源。

const tc = (name: string, args: Record<string, unknown> = {}, id = name + Math.random()): ToolCall =>
  ({ id, name, arguments: args }) as ToolCall;

const msg = (toolCalls: ToolCall[]): Message => ({ toolCalls } as unknown as Message);

describe('extractToolCalls', () => {
  it('从多条消息聚合 toolCalls，跳过空集合', () => {
    const messages = [msg([tc('read'), tc('write')]), msg([]), msg([tc('task')])];
    expect(extractToolCalls(messages).map((t) => t.name)).toEqual(['read', 'write', 'task']);
  });

  it('无 toolCalls 字段的消息被安全跳过', () => {
    expect(extractToolCalls([{} as unknown as Message])).toEqual([]);
  });
});

describe('isMultiAgentToolCall', () => {
  it('识别 spawn/communication/delegation/orchestration 工具', () => {
    expect(isMultiAgentToolCall(tc('spawn_agent'))).toBe(true);
    expect(isMultiAgentToolCall(tc('agent_message'))).toBe(true);
    expect(isMultiAgentToolCall(tc('task'))).toBe(true);
    expect(isMultiAgentToolCall(tc('orchestrate'))).toBe(true);
  });

  it('普通工具不算多 Agent', () => {
    expect(isMultiAgentToolCall(tc('read'))).toBe(false);
  });
});

describe('extractAgentName', () => {
  it('按字段优先级取名', () => {
    expect(extractAgentName(tc('spawn_agent', { agent_name: 'researcher' }))).toBe('researcher');
    expect(extractAgentName(tc('agent_send', { target: 'writer' }))).toBe('writer');
  });

  it('task 工具回退到 subagent_type / assigned_to', () => {
    expect(extractAgentName(tc('task', { subagent_type: 'explorer' }))).toBe('explorer');
    expect(extractAgentName(tc('task', { assigned_to: 'planner' }))).toBe('planner');
  });

  it('无任何可识别字段返回 null；非字符串字段忽略', () => {
    expect(extractAgentName(tc('spawn_agent', {}))).toBeNull();
    expect(extractAgentName(tc('spawn_agent', { name: 123 }))).toBeNull();
  });
});

describe('detectPattern', () => {
  it('无多 Agent 工具 → single', () => {
    expect(detectPattern([tc('read'), tc('write')])).toBe('single');
  });

  it('编排工具 → hierarchical', () => {
    expect(detectPattern([tc('coordinate_agents')])).toBe('hierarchical');
  });

  it('连续多次 spawn → parallel', () => {
    expect(detectPattern([tc('spawn_agent', {}, 's1'), tc('spawn_agent', {}, 's2')])).toBe('parallel');
  });

  it('spawn 间隔过大（>3）→ 退化为 sequential', () => {
    const calls = [
      tc('spawn_agent', {}, 's1'),
      tc('read', {}, 'r1'),
      tc('read', {}, 'r2'),
      tc('read', {}, 'r3'),
      tc('read', {}, 'r4'),
      tc('spawn_agent', {}, 's2'),
    ];
    expect(detectPattern(calls)).toBe('sequential');
  });

  it('多个 task 委派给不同 agent → parallel', () => {
    const calls = [
      tc('task', { subagent_type: 'researcher' }, 't1'),
      tc('task', { subagent_type: 'writer' }, 't2'),
    ];
    expect(detectPattern(calls)).toBe('parallel');
  });

  it('多个 task 但目标相同 → 非 parallel，落到 sequential', () => {
    const calls = [
      tc('task', { subagent_type: 'same' }, 't1'),
      tc('task', { subagent_type: 'same' }, 't2'),
    ];
    expect(detectPattern(calls)).toBe('sequential');
  });

  it('存在 agent 通信工具 → sequential', () => {
    expect(detectPattern([tc('agent_message', { target: 'a' })])).toBe('sequential');
  });

  it('spawn + task 混合 → sequential', () => {
    expect(detectPattern([tc('spawn_agent', { name: 'a' }), tc('task', { subagent_type: 'b' })])).toBe('sequential');
  });

  it('单个 spawn 无其他信号 → sequential 兜底', () => {
    expect(detectPattern([tc('agent_create', {})])).toBe('sequential');
  });
});

describe('extractActiveAgents', () => {
  it('总是包含 main', () => {
    expect(extractActiveAgents([tc('read')])).toEqual(['main']);
  });

  it('收集 agent 名并对 spawn 额外提取 role/type/agent_type', () => {
    const agents = extractActiveAgents([
      tc('spawn_agent', { agent_name: 'researcher', role: 'lead', type: 'analyst', agent_type: 'worker' }),
      tc('read'), // 非多 Agent 工具被跳过
      tc('task', { subagent_type: 'writer' }),
    ]);
    expect(agents).toContain('main');
    expect(agents).toContain('researcher');
    expect(agents).toContain('lead');
    expect(agents).toContain('analyst');
    expect(agents).toContain('worker');
    expect(agents).toContain('writer');
  });

  it('去重：同名 agent 只出现一次', () => {
    const agents = extractActiveAgents([
      tc('spawn_agent', { agent_name: 'dup' }),
      tc('agent_message', { target: 'dup' }),
    ]);
    expect(agents.filter((a) => a === 'dup')).toHaveLength(1);
  });
});
