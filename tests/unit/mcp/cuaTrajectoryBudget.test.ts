import { describe, it, expect, afterEach } from 'vitest';
import {
  gateCuaBudget,
  resetCuaBudget,
  getCuaBudgetLimit,
  CUA_DEFAULT_BUDGET,
} from '../../../src/host/mcp/cuaTrajectoryBudget';

// 轨迹预算上限：一次 run 内 CUA 操控类动作的软停约束。
// 动机：2026-06-11 真机 E2E 计算器任务跑了 35 回合 / 334 万 tokens，
// 轨迹失控没有任何机制兜底（对照 cua-agent SDK 的 max_trajectory_budget）。
describe('cuaTrajectoryBudget — 轨迹预算软停', () => {
  afterEach(() => {
    delete process.env.CODE_AGENT_CUA_BUDGET;
    resetCuaBudget('s1');
    resetCuaBudget('s2');
  });

  it('默认预算 25，env 可调', () => {
    expect(CUA_DEFAULT_BUDGET).toBe(25);
    expect(getCuaBudgetLimit()).toBe(25);
    process.env.CODE_AGENT_CUA_BUDGET = '5';
    expect(getCuaBudgetLimit()).toBe(5);
  });

  it('预算内的操控动作放行并计数', () => {
    process.env.CODE_AGENT_CUA_BUDGET = '3';
    expect(gateCuaBudget('click', 's1')).toBeNull();
    expect(gateCuaBudget('type_text', 's1')).toBeNull();
    expect(gateCuaBudget('press_key', 's1')).toBeNull();
  });

  it('超限后操控动作被拒，提示包含收尾指引', () => {
    process.env.CODE_AGENT_CUA_BUDGET = '2';
    gateCuaBudget('click', 's1');
    gateCuaBudget('click', 's1');
    const err = gateCuaBudget('click', 's1');
    expect(err).not.toBeNull();
    expect(err).toContain('轨迹预算');
    expect(err).toContain('总结');
  });

  it('只读观察工具不计数、超限后也放行（鼓励多看少动+允许收尾观察）', () => {
    process.env.CODE_AGENT_CUA_BUDGET = '1';
    for (let i = 0; i < 10; i++) {
      expect(gateCuaBudget('get_window_state', 's1')).toBeNull();
    }
    expect(gateCuaBudget('click', 's1')).toBeNull(); // 第 1 次操控
    expect(gateCuaBudget('click', 's1')).not.toBeNull(); // 超限
    expect(gateCuaBudget('get_window_state', 's1')).toBeNull(); // 收尾观察仍放行
    expect(gateCuaBudget('end_session', 's1')).toBeNull(); // 善后仍放行
  });

  it('预算按 session 隔离', () => {
    process.env.CODE_AGENT_CUA_BUDGET = '1';
    expect(gateCuaBudget('click', 's1')).toBeNull();
    expect(gateCuaBudget('click', 's1')).not.toBeNull();
    expect(gateCuaBudget('click', 's2')).toBeNull();
  });

  it('reset 后预算恢复（RunFinalizer 在 run 结束调用）', () => {
    process.env.CODE_AGENT_CUA_BUDGET = '1';
    gateCuaBudget('click', 's1');
    expect(gateCuaBudget('click', 's1')).not.toBeNull();
    resetCuaBudget('s1');
    expect(gateCuaBudget('click', 's1')).toBeNull();
  });

  it('非法 env 值回落默认', () => {
    process.env.CODE_AGENT_CUA_BUDGET = 'abc';
    expect(getCuaBudgetLimit()).toBe(CUA_DEFAULT_BUDGET);
    process.env.CODE_AGENT_CUA_BUDGET = '0';
    expect(getCuaBudgetLimit()).toBe(CUA_DEFAULT_BUDGET);
  });
});
