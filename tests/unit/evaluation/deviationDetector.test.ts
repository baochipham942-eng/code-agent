import { describe, expect, it } from 'vitest';
import { DeviationDetector } from '../../../src/host/evaluation/trajectory/deviationDetector';
import type { Trajectory, TrajectoryStep } from '../../../src/host/testing/types';

// ADR-036 F4b：DeviationDetector 已实现且在 telemetryQueryService 真用，但此前零测试。
// detectByRules 是纯确定性规则，补齐四条规则的覆盖，防规则被静默改坏。

function toolStep(
  index: number,
  name: string,
  args: Record<string, unknown>,
  success = true,
): TrajectoryStep {
  return { index, timestamp: index, type: 'tool_call', toolCall: { name, args, success, duration: 1 } };
}

function trajectoryOf(steps: TrajectoryStep[]): Trajectory {
  // detectByRules 只读 .steps，其余字段给壳即可。
  return { steps } as unknown as Trajectory;
}

describe('DeviationDetector.detectByRules（ADR-036 F4b）', () => {
  const detector = new DeviationDetector();

  it('loop：同工具+相似参数连续 ≥3 次标 loop，≥5 次升 high', () => {
    const steps = Array.from({ length: 5 }, (_, i) => toolStep(i, 'bash', { command: 'ls' }));
    const markers = detector.detectByRules(trajectoryOf(steps));
    const loop = markers.find((m) => m.type === 'loop');
    expect(loop).toBeDefined();
    expect(loop!.severity).toBe('high'); // 5 次
    expect(loop!.stepIndex).toBe(0);
  });

  it('loop：连续 2 次不触发（阈值是 3）', () => {
    const steps = [toolStep(0, 'bash', { command: 'ls' }), toolStep(1, 'bash', { command: 'ls' })];
    expect(detector.detectByRules(trajectoryOf(steps)).some((m) => m.type === 'loop')).toBe(false);
  });

  it('unnecessary_step：失败工具调用后无同工具重试 → 标记', () => {
    const steps = [toolStep(0, 'read_file', { path: '/a' }, false), toolStep(1, 'bash', { command: 'echo' })];
    const markers = detector.detectByRules(trajectoryOf(steps));
    expect(markers.some((m) => m.type === 'unnecessary_step')).toBe(true);
  });

  it('wrong_args：bash 空命令 + Read 空路径都标 wrong_args', () => {
    const steps = [toolStep(0, 'bash', { command: '   ' }), toolStep(1, 'Read', { file_path: '' })];
    const markers = detector.detectByRules(trajectoryOf(steps));
    expect(markers.filter((m) => m.type === 'wrong_args')).toHaveLength(2);
  });

  it('hallucination：成功调用后又用完全相同参数再调一次 → 疑似忽略结果', () => {
    const steps = [
      toolStep(0, 'read_file', { path: '/same' }, true),
      toolStep(1, 'read_file', { path: '/same' }, true),
    ];
    const markers = detector.detectByRules(trajectoryOf(steps));
    const h = markers.find((m) => m.type === 'hallucination');
    expect(h).toBeDefined();
    expect(h!.stepIndex).toBe(1);
  });

  it('无偏差轨迹返回空数组', () => {
    const steps = [toolStep(0, 'bash', { command: 'ls' }), toolStep(1, 'read_file', { path: '/a' })];
    expect(detector.detectByRules(trajectoryOf(steps))).toEqual([]);
  });
});
