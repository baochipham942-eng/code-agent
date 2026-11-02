import { describe, expect, it } from 'vitest';
import { recordScopedCost } from '../../../src/host/services/core/scopedCostLimit';
import { runWithCronJobBudget } from '../../../src/host/cron/cronExecutionPolicy';
import {
  attachCronRunCost,
  createCronRunCostMeter,
  readCronRunCostUsd,
} from '../../../src/host/cron/cronRunCostMeter';

describe('createCronRunCostMeter', () => {
  it('无预算：纯计量，run 结束读出真实 usage 成本', async () => {
    const meter = createCronRunCostMeter(undefined);
    const value = await meter.run(async () => {
      recordScopedCost(0.0123);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(meter.getCostUsd()).toBeCloseTo(0.0123);
  });

  it('带预算：越线仍由 runWithCronJobBudget 转成既有预算超限消息（措辞归 cronExecutionPolicy）', async () => {
    const meter = createCronRunCostMeter(0.5);
    await expect(
      runWithCronJobBudget(0.5, () =>
        meter.run(async () => {
          recordScopedCost(0.6);
          return 'ok';
        }),
      ),
    ).rejects.toThrow(/exceeded its \$0\.50 budget limit/);
    expect(meter.getCostUsd()).toBeCloseTo(0.6);
  });

  it('同一次 run 内多段调用累计', async () => {
    const meter = createCronRunCostMeter(null);
    await meter.run(async () => {
      recordScopedCost(0.01);
      recordScopedCost(0.02);
    });
    expect(meter.getCostUsd()).toBeCloseTo(0.03);
  });

  it('带预算且未越线：行为与无预算一致（计量不改变成功路径）', async () => {
    const meter = createCronRunCostMeter(1);
    const value = await runWithCronJobBudget(1, () =>
      meter.run(async () => {
        recordScopedCost(0.02);
        return 42;
      }),
    );
    expect(value).toBe(42);
    expect(meter.getCostUsd()).toBeCloseTo(0.02);
  });
});

describe('readCronRunCostUsd', () => {
  it('CronAgentActionResult 形状读出 costUsd', () => {
    expect(
      readCronRunCostUsd({ agentType: 'default', prompt: 'p', result: undefined, sessionId: 's', costUsd: 0.02 }),
    ).toBeCloseTo(0.02);
  });

  it('role-wake 结果形状读出 costUsd', () => {
    expect(readCronRunCostUsd({ roleId: 'r', trigger: 'cadence', status: 'completed', costUsd: 0.03 })).toBeCloseTo(0.03);
  });

  it('失败路径：挂在 Error 上的 cronRunCostUsd', () => {
    const error = new Error('boom');
    (error as Error & { cronRunCostUsd?: number }).cronRunCostUsd = 0.04;
    expect(readCronRunCostUsd(error)).toBeCloseTo(0.04);
  });

  it('陌生 result 不猜成本（云端结果/模型自由文本）', () => {
    expect(readCronRunCostUsd({ costUsd: 9 })).toBeUndefined();
    expect(readCronRunCostUsd('done')).toBeUndefined();
  });

  it('非正数读数忽略（无模型调用）', () => {
    expect(readCronRunCostUsd({ agentType: 'default', prompt: 'p', result: undefined, sessionId: 's', costUsd: 0 })).toBeUndefined();
  });
});

describe('attachCronRunCost', () => {
  it('零成本不挂（失败早于任何模型调用）', () => {
    const meter = createCronRunCostMeter(undefined);
    const error = new Error('infra down');
    attachCronRunCost(error, meter);
    expect((error as Error & { cronRunCostUsd?: number }).cronRunCostUsd).toBeUndefined();
  });

  it('有读数时挂到 Error 上，供失败路径记账', async () => {
    const meter = createCronRunCostMeter(undefined);
    let caught: unknown;
    try {
      await meter.run(async () => {
        recordScopedCost(0.07);
        throw new Error('late failure');
      });
    } catch (error) {
      caught = error;
    }
    attachCronRunCost(caught, meter);
    expect(readCronRunCostUsd(caught)).toBeCloseTo(0.07);
  });

  it('不覆盖已有读数', async () => {
    const meter = createCronRunCostMeter(undefined);
    const error = new Error('boom');
    (error as Error & { cronRunCostUsd?: number }).cronRunCostUsd = 0.01;
    try {
      await meter.run(async () => {
        recordScopedCost(0.07);
        throw error;
      });
    } catch {
      // 抛出的是同一个 error 对象
    }
    attachCronRunCost(error, meter);
    expect(readCronRunCostUsd(error)).toBeCloseTo(0.01);
  });
});
