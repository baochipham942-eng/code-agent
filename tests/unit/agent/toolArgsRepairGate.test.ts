import { describe, expect, it } from 'vitest';
import {
  ToolArgsRepairGate,
  buildRepairExhaustedMessage,
} from '../../../src/host/agent/runtime/toolArgsRepairGate';

describe('ToolArgsRepairGate', () => {
  it('counts consecutive failures and only exhausts past the max', () => {
    const gate = new ToolArgsRepairGate(2);
    expect(gate.recordFailure('write_file')).toEqual({ attempt: 1, exhausted: false });
    expect(gate.recordFailure('write_file')).toEqual({ attempt: 2, exhausted: false });
    // 第 3 次连续失败超过上限 → 触发终止
    expect(gate.recordFailure('write_file')).toEqual({ attempt: 3, exhausted: true });
  });

  it('resets a tool counter on success so later failures start fresh', () => {
    const gate = new ToolArgsRepairGate(2);
    gate.recordFailure('read_file');
    gate.recordFailure('read_file');
    gate.recordSuccess('read_file');
    expect(gate.recordFailure('read_file')).toEqual({ attempt: 1, exhausted: false });
  });

  it('tracks each tool independently', () => {
    const gate = new ToolArgsRepairGate(2);
    gate.recordFailure('a');
    gate.recordFailure('a');
    // 另一个工具的失败不受 a 的计数影响
    expect(gate.recordFailure('b')).toEqual({ attempt: 1, exhausted: false });
    // a 再失败一次才耗尽
    expect(gate.recordFailure('a')).toEqual({ attempt: 3, exhausted: true });
  });

  it('reset clears all counters', () => {
    const gate = new ToolArgsRepairGate(2);
    gate.recordFailure('a');
    gate.recordFailure('a');
    gate.reset();
    expect(gate.recordFailure('a')).toEqual({ attempt: 1, exhausted: false });
  });

  it('a max of 1 allows a single repair before exhausting', () => {
    const gate = new ToolArgsRepairGate(1);
    expect(gate.recordFailure('x').exhausted).toBe(false); // attempt 1 = the one allowed repair
    expect(gate.recordFailure('x').exhausted).toBe(true);  // attempt 2 > max
  });
});

describe('buildRepairExhaustedMessage', () => {
  it('names the tool, the attempt count, and tells the model to stop retrying it', () => {
    const msg = buildRepairExhaustedMessage('write_file', 3);
    expect(msg).toContain('write_file');
    expect(msg).toContain('3');
    // 必须明确指引模型停止重试该工具、改换路子
    expect(msg).toMatch(/停止|不要再|换/);
  });
});
