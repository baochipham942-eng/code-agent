// ============================================================================
// 协作可见性（P1-3）：子代理自报 STATUS / DECISION 解析（讨论流人话状态来源）
// ============================================================================
import { describe, it, expect } from 'vitest';
import { parseStatusReport, SWARM_STATUS_REPORT_SUFFIX } from '../../../src/main/agent/multiagentTools/statusReport';

describe('parseStatusReport', () => {
  it('提取末尾的 STATUS 与 DECISION 行', () => {
    const output = [
      '我已分析了接口契约并完成调研。',
      '',
      'STATUS: 调研完成，未改动产品代码',
      'DECISION: 采用服务端聚合方案，避免前端多次往返',
    ].join('\n');

    expect(parseStatusReport(output)).toEqual({
      status: '调研完成，未改动产品代码',
      decision: '采用服务端聚合方案，避免前端多次往返',
    });
  });

  it('只有 STATUS 时 decision 为 undefined', () => {
    expect(parseStatusReport('done\nSTATUS: 已完成单测')).toEqual({
      status: '已完成单测',
      decision: undefined,
    });
  });

  it('大小写不敏感且兼容中文冒号、行首空白', () => {
    const output = '  status：完成了\n\tDecision： 选 A';
    expect(parseStatusReport(output)).toEqual({ status: '完成了', decision: '选 A' });
  });

  it('多次出现时以最后一行为准', () => {
    const output = 'STATUS: 旧的\n...\nSTATUS: 新的';
    expect(parseStatusReport(output).status).toBe('新的');
  });

  it('无状态行 / 空内容时返回空对象，不误报', () => {
    expect(parseStatusReport('普通输出，无状态行')).toEqual({});
    expect(parseStatusReport('STATUS:   ')).toEqual({});
    expect(parseStatusReport('')).toEqual({});
  });

  it('自报后缀包含 STATUS 与 DECISION 指令，确保子代理被要求自报', () => {
    expect(SWARM_STATUS_REPORT_SUFFIX).toContain('STATUS:');
    expect(SWARM_STATUS_REPORT_SUFFIX).toContain('DECISION:');
  });
});
