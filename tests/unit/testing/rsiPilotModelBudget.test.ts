// ============================================================================
// N-SOL-GAME-AB-FU2：rsi-pilot runner 的 per-model 时间/输出预算
// ============================================================================
// 父单 N-SOL-GAME-AB FC-2：glm-5.3 在 18/18 unit 撞 600s 硬超时（kill 时
// stream snapshot = 55,842 chars reasoning / 0 chars content，一个工具轮都没完成）。
// modelBudget.ts 按实测给它更长超时与更高 maxTokens；未知模型必须与旧行为
// 逐字节一致（600s + 适配器默认 maxTokens 16384）。
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MODEL_MAX_TOKENS } from '../../../src/shared/constants/defaults';
import { BASH } from '../../../src/shared/constants/tools';
import { MODEL_UNIT_BUDGETS, resolveUnitBudget } from '../../../scripts/rsi-pilot/modelBudget';
import { realRun } from '../../../scripts/rsi-pilot/runner';

const GLM_BUDGET = MODEL_UNIT_BUDGETS['glm-5.3']!;

describe('rsi pilot per-model budget（N-SOL-GAME-AB-FU2）', () => {
  it('表查询：glm-5.3 命中实测预算（超时 > 旧默认，maxTokens = EXTENDED）', () => {
    expect(GLM_BUDGET).toBeDefined();
    expect(GLM_BUDGET.timeoutMs).toBeGreaterThan(BASH.MAX_TIMEOUT);
    expect(GLM_BUDGET.maxTokens).toBe(MODEL_MAX_TOKENS.EXTENDED);
    // 按 model id 命中，不挑 provider（zhipu / zhipu_coding 同一个模型）
    expect(resolveUnitBudget('zhipu_coding', 'glm-5.3')).toEqual(GLM_BUDGET);
    expect(resolveUnitBudget('zhipu', 'glm-5.3')).toEqual(GLM_BUDGET);
  });

  it('未知模型：与旧行为逐字节一致（600s 硬超时 + 适配器默认 maxTokens）', () => {
    expect(resolveUnitBudget('longcat', 'LongCat-2.0')).toEqual({ timeoutMs: BASH.MAX_TIMEOUT, maxTokens: null });
    expect(resolveUnitBudget('openai', 'gpt-6.1-sol')).toEqual({ timeoutMs: BASH.MAX_TIMEOUT, maxTokens: null });
    // null 的语义 = runner 不写 modelConfig.maxTokens ⇒ 适配器回落 MODEL_MAX_TOKENS.DEFAULT
    expect(MODEL_MAX_TOKENS.DEFAULT).toBe(16384);
  });

  it('CLI 覆盖逐字段赢过表（含未知模型）', () => {
    expect(resolveUnitBudget('zhipu_coding', 'glm-5.3', { timeoutMs: 300_000 })).toEqual({ ...GLM_BUDGET, timeoutMs: 300_000 });
    expect(resolveUnitBudget('longcat', 'LongCat-2.0', { maxTokens: 8_192 })).toEqual({ timeoutMs: BASH.MAX_TIMEOUT, maxTokens: 8_192 });
    expect(resolveUnitBudget('longcat', 'LongCat-2.0', { timeoutMs: 90_000, maxTokens: 4_096 })).toEqual({ timeoutMs: 90_000, maxTokens: 4_096 });
  });

  it('非正数/非整数覆盖 fail-closed 拒绝，不静默回落表值', () => {
    expect(() => resolveUnitBudget('zhipu_coding', 'glm-5.3', { timeoutMs: 0 })).toThrow(/timeout-ms/);
    expect(() => resolveUnitBudget('zhipu_coding', 'glm-5.3', { maxTokens: -1 })).toThrow(/max-tokens/);
    expect(() => resolveUnitBudget('zhipu_coding', 'glm-5.3', { maxTokens: 1.5 })).toThrow(/max-tokens/);
    expect(() => resolveUnitBudget('zhipu_coding', 'glm-5.3', { timeoutMs: Number.NaN })).toThrow(/timeout-ms/);
  });

  it('realRun：适配器收到表选 maxTokens，超时按所选预算杀而不是 600s', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-budget-'));
    const casesPath = path.join(root, 'cases.json');
    await fs.writeFile(casesPath, JSON.stringify({
      version: 1,
      note: '',
      cases: [{ id: 'x', subtype: 'runner', split: 'held_in', prompt: 'make x.html' }],
    }));
    const outDir = path.join(root, 'out');
    const seenConfigs: unknown[] = [];
    let adapterConstructed!: () => void;
    const adapterConstructedPromise = new Promise<void>((resolve) => { adapterConstructed = resolve; });
    class StubAdapter {
      workingDirectory: string;

      constructor(config: any) {
        seenConfigs.push(config);
        this.workingDirectory = config.workingDirectory;
        adapterConstructed();
      }
      sendMessage() { return new Promise<never>(() => {}); } // 永不结束：超时路径是唯一出口
      async finalizeSession() {}
      getSessionId() { return undefined; }
      async cancelActiveRun() {}
    }
    const chosenTimeoutMs = 90_000;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-07T00:00:00.000Z'));
    try {
      const runPromise = realRun({
        casesPath, split: 'all', reps: 1, provider: 'zhipu_coding', model: 'glm-5.3',
        label: 'budget', outDir, ids: undefined, rep: undefined, limit: 1,
        timeoutMs: chosenTimeoutMs,
      }, {
        StandaloneAgentAdapter: StubAdapter as any,
        validateGameArtifact: async () => ({ passed: true, failures: [] }),
        inferArtifactRepairIssueCodesFromText: () => [],
        getTelemetryCollector: () => ({ getSessionData: () => null }),
        gameValidationTimeouts: { RUNTIME_SMOKE_MS: 1, BROWSER_VISUAL_SMOKE_MS: 1, LIGHT_PLAYABILITY_SMOKE_MS: 1 },
        HARNESS_KNOB_DEFAULTS: {},
        ensureEvalDatabase: async () => {},
      });
      await adapterConstructedPromise;
      await vi.advanceTimersByTimeAsync(chosenTimeoutMs);
      await runPromise;
    } finally {
      vi.useRealTimers();
    }
    const record = JSON.parse((await fs.readFile(path.join(outDir, 'runs.jsonl'), 'utf8')).trim());
    expect(record.timedOut).toBe(true);
    expect(record.error).toBe(`per-run hard timeout after ${chosenTimeoutMs}ms`);
    // 杀在所选超时上，而不是旧默认 600s
    expect(record.durationMs).toBe(chosenTimeoutMs);
    // 适配器构造参数：表选 maxTokens（CLI 只覆盖了超时）真传下去了
    expect(seenConfigs[0]).toMatchObject({
      modelConfig: { provider: 'zhipu_coding', model: 'glm-5.3', maxTokens: GLM_BUDGET.maxTokens },
    });
    // harness 戳带上实际生效的预算（run 间可比）：覆盖后的超时 + 表选 maxTokens
    expect(record.harness.budget).toEqual({ timeoutMs: chosenTimeoutMs, maxTokens: GLM_BUDGET.maxTokens });
  });
});
