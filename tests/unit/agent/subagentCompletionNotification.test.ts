import { describe, expect, it } from 'vitest';
import {
  buildSubagentCompletionRecord,
  formatSystemReminderForCompletions,
} from '../../../src/host/agent/subagentCompletionNotification';

function completion(kind?: 'user_visible' | 'internal' | 'shell') {
  return buildSubagentCompletionRecord({
    agentId: 'subagent-42',
    title: '依赖核验',
    role: 'reviewer',
    ...(kind ? { kind } : {}),
    status: 'completed',
    output: '核验完成，三个依赖均可用。',
    startedAt: 100,
    finishedAt: 250,
  });
}

describe('subagent completion response contract', () => {
  it('asks for one summary sentence without repeating a result already visible to the user', () => {
    const record = completion('user_visible');

    expect(record.content).toContain('"completion_kind": "user_visible"');
    expect(record.content).toContain('结果已经展示给用户，不要复述子代理的原始结果');
    expect(record.content).toContain('只用一句话归纳本批通知里的全部完成项');
    expect(record.content).toMatch(
      /<completion_ack_instruction>[\s\S]+<\/completion_ack_instruction>\n<\/subagent_notification>$/,
    );
  });

  it('asks for necessary follow-up and no user response when the result is internal', () => {
    const record = completion('internal');

    expect(record.content).toContain('"completion_kind": "internal"');
    expect(record.content).toContain('先完成必要的后续动作');
    expect(record.content).toContain('没有后续动作时，不要回复用户');
  });

  it('asks for a non-technical result brief and next step after a shell completion', () => {
    const record = completion('shell');

    expect(record.content).toContain('"completion_kind": "shell"');
    expect(record.content).toContain('用简短、非技术化的话');
    expect(record.content).toContain('执行结果和下一步');
    expect(record.content).toContain('不要只罗列退出码、日志或命令细节');
  });

  it('defaults missing kind to internal and requires the recorded title instead of a generic agent label', () => {
    const record = completion();
    const reminder = formatSystemReminderForCompletions([record]);

    expect(record.kind).toBe('internal');
    expect(record.content).toContain('只能使用通知中的标题「依赖核验」');
    expect(record.content).toContain('禁止使用 [agent]、[worker]、agent 或 worker 等泛称');
    expect(reminder).toContain('- 依赖核验 (reviewer): completed, duration_ms=150');
    expect(reminder).not.toContain('- subagent-42 (reviewer):');
  });
});
