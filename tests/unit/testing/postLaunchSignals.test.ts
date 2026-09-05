// 九类确定性信号，每类一真阳一真阴。真阴不是「没报错」，是「长得像但不该判」——
// 判定器只喂正例自测等于没测（多次实付：匹配式只验真阳，上线后真阴全是误报）。
import { describe, expect, it } from 'vitest';
import type { ReplayBlock, ReplayToolCall, ReplayTurn } from '../../../src/shared/contract/evaluationReplay';
import { computeTurnSignals } from '../../../src/host/testing/postlaunch/postLaunchSignals';
import type { PostLaunchSignalKind } from '../../../src/shared/contract/postLaunchScore';

const WORKSPACE = '/ws';

function turn(blocks: ReplayBlock[]): ReplayTurn {
  return {
    turnNumber: 1,
    turnType: 'user',
    blocks,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 1000,
    startTime: 0,
  };
}

function errorBlock(content: string, timestamp = 10): ReplayBlock {
  return { type: 'error', content, timestamp };
}

function textBlock(content: string, timestamp = 10): ReplayBlock {
  return { type: 'text', content, timestamp };
}

function eventBlock(eventType: string, summary: string, timestamp = 10): ReplayBlock {
  return { type: 'event', content: summary, timestamp, event: { eventType, summary } };
}

function toolBlock(
  partial: Partial<ReplayToolCall> & { name: string },
  timestamp = 10,
): ReplayBlock {
  const toolCall: ReplayToolCall = {
    id: `${partial.name}-${timestamp}`,
    args: {},
    success: true,
    duration: 1,
    category: 'Read',
    ...partial,
  };
  return { type: 'tool_call', content: toolCall.name, timestamp, toolCall };
}

function kinds(blocks: ReplayBlock[], context = {}): PostLaunchSignalKind[] {
  return computeTurnSignals(turn(blocks), 'turn-1', context).map((signal) => signal.kind);
}

describe('确定性信号 · 九类各一真阳一真阴', () => {
  it('①错误终止：真错误判出；正常收尾不判', () => {
    expect(kinds([errorBlock('TypeError: fn is not a function')])).toContain('error_terminated');
    expect(kinds([toolBlock({ name: 'Read' }), textBlock('看完了')])).not.toContain('error_terminated');
  });

  it('②用户取消：agent_cancelled 判出；磁盘满这类错误不算取消', () => {
    expect(kinds([eventBlock('agent_cancelled', '被用户中止')])).toContain('user_cancelled');
    expect(kinds([errorBlock('ENOSPC: no space left on device')])).not.toContain('user_cancelled');
  });

  it('③审批被拒：拒绝文案判出；网络不可达不算被拒', () => {
    expect(kinds([errorBlock('Permission denied by user')])).toContain('approval_denied');
    expect(kinds([errorBlock('network unreachable')])).not.toContain('approval_denied');
  });

  it('④审批被拒后绕行：被拒后又成功跑了 Bash 才算；被拒后只读文件不算', () => {
    const bypassed = kinds([
      errorBlock('Permission denied by user', 10),
      toolBlock({ name: 'Bash', category: 'Bash', success: true }, 20),
    ]);
    expect(bypassed).toContain('approval_bypassed');

    const readOnly = kinds([
      errorBlock('Permission denied by user', 10),
      toolBlock({ name: 'Read', category: 'Read', success: true }, 20),
    ]);
    expect(readOnly).toContain('approval_denied');
    expect(readOnly).not.toContain('approval_bypassed');
  });

  it('⑤超时：超时文案判出；参数非法不算超时', () => {
    expect(kinds([errorBlock('Request timeout after 30000ms')])).toContain('timeout');
    expect(kinds([errorBlock('invalid argument: path must be absolute')])).not.toContain('timeout');
  });

  it('⑥成本异常：超阈值判出；正常单轮成本不判', () => {
    expect(kinds([textBlock('好了')], { turnCostUsd: 0.5, costAnomalyUsd: 0.2 })).toContain('cost_anomaly');
    expect(kinds([textBlock('好了')], { turnCostUsd: 0.01, costAnomalyUsd: 0.2 })).not.toContain('cost_anomaly');
  });

  it('⑦重复循环：同工具同参数连续三次判出；参数变了不判', () => {
    const same = { name: 'Read', args: { path: 'a.ts' } };
    expect(kinds([toolBlock(same, 1), toolBlock(same, 2), toolBlock(same, 3)])).toContain('repeat_loop');
    expect(kinds([
      toolBlock(same, 1),
      toolBlock(same, 2),
      toolBlock({ name: 'Read', args: { path: 'b.ts' } }, 3),
    ])).not.toContain('repeat_loop');
  });

  it('⑧声称文件不存在：磁盘上没有才判；文件真在就不判', () => {
    const claim = [textBlock('已写入 ./out/report.html')];
    expect(kinds(claim, { workspaceDir: WORKSPACE, fileExists: () => false })).toContain('claimed_file_missing');
    expect(kinds(claim, { workspaceDir: WORKSPACE, fileExists: () => true })).not.toContain('claimed_file_missing');
  });

  it('⑨越出工作区写入：写到工作目录外判出；写工作目录内不判', () => {
    const outside = toolBlock({ name: 'Write', category: 'Write', args: { path: '/etc/hosts' } });
    expect(kinds([outside], { workspaceDir: WORKSPACE })).toContain('out_of_workspace_write');

    const inside = toolBlock({ name: 'Write', category: 'Write', args: { path: './src/a.ts' } });
    expect(kinds([inside], { workspaceDir: WORKSPACE })).not.toContain('out_of_workspace_write');
  });

  it('一条错误文本只归一类：被拒不会同时算成泛错误', () => {
    const result = kinds([errorBlock('Permission denied by user')]);
    expect(result).toContain('approval_denied');
    expect(result).not.toContain('error_terminated');
  });

  it('没有工作目录时，产物与越权两类不猜——宁可不判也不误判', () => {
    const result = kinds([
      textBlock('已写入 ./out/report.html'),
      toolBlock({ name: 'Write', category: 'Write', args: { path: '/etc/hosts' } }),
    ], { fileExists: () => false });
    expect(result).not.toContain('claimed_file_missing');
    expect(result).not.toContain('out_of_workspace_write');
  });
});
