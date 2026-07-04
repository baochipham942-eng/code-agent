// ============================================================================
// WP2 验收 dogfood（手动，不进 CI）：真 LongCat 会话验证 cache-aware 记账
// 跑法：DOGFOOD_CACHE=1 npx vitest run tests/dogfoodCacheEconomics.manual.test.ts
// key 从 ~/.code-agent/secure-storage.json 内存解密（apikey.longcat），绝不打印。
// ============================================================================
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LongCatProvider } from '../src/host/model/providers/longcatProvider';
import { BudgetService } from '../src/host/services/core/budgetService';
import type { ModelMessage } from '../src/host/model/types';
import type { ModelConfig } from '../src/shared/contract';

function loadLongcatKey(): string | null {
  try {
    const dir = path.join(os.homedir(), '.code-agent');
    const secret = fs.readFileSync(path.join(dir, '.secure-key'), 'utf-8').trim();
    const key = crypto.createHash('sha256').update(secret).digest();
    const payload = JSON.parse(fs.readFileSync(path.join(dir, 'secure-storage.json'), 'utf-8')) as {
      iv: string; tag: string; data: string;
    };
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
    const store = JSON.parse(decrypted) as Record<string, string>;
    return store['apikey.longcat'] ?? null;
  } catch {
    return null;
  }
}

const RUN = process.env.DOGFOOD_CACHE === '1';

// 共享长前缀（拉高 input tokens，观察 provider 是否报缓存命中字段）
const LONG_SYSTEM = [
  'You are Agent Neo, a cowork assistant. Follow these standing rules strictly.',
  ...Array.from({ length: 60 }, (_, i) =>
    `Rule ${i + 1}: when handling scenario ${i + 1}, always double check inputs, keep outputs concise, never fabricate data, and prefer reversible actions over irreversible ones in ambiguous situations.`),
].join('\n');

describe.runIf(RUN)('dogfood: LongCat 真会话 cache-aware 记账', () => {
  it('two real calls → provider usage flows into cache-aware budget', async () => {
    const apiKey = loadLongcatKey();
    expect(apiKey, 'longcat key 未配置（secure-storage 里没有 apikey.longcat）').toBeTruthy();

    const provider = new LongCatProvider();
    const config: ModelConfig = {
      provider: 'longcat',
      model: 'LongCat-2.0',
      apiKey: apiKey!,
      baseUrl: 'https://api.longcat.chat/openai/v1',
      maxTokens: 256,
      temperature: 0.2,
    } as ModelConfig;

    const budget = new BudgetService({ enabled: true, maxBudget: 100 });
    const report: Record<string, unknown>[] = [];

    for (const [label, question] of [
      ['call-1', 'Reply with exactly: OK-1'],
      ['call-2', 'Reply with exactly: OK-2'],
    ] as const) {
      const messages: ModelMessage[] = [
        { role: 'system', content: LONG_SYSTEM },
        { role: 'user', content: question },
      ];
      // 非流式（onStream undefined）→ parseOpenAIResponse 带回归一化 usage
      const response = await provider.inference(messages, [], config, undefined, undefined, { forceNonStreaming: true });
      const usage = response.usage;
      expect(usage, 'provider 未回传 usage').toBeTruthy();
      budget.recordUsage({
        inputTokens: usage!.inputTokens,
        outputTokens: usage!.outputTokens,
        cacheReadTokens: usage!.cacheReadTokens,
        cacheCreationTokens: usage!.cacheCreationTokens,
        model: config.model,
        provider: config.provider,
        timestamp: Date.now(),
      });
      report.push({
        label,
        content: (response.content ?? '').slice(0, 40),
        usage,
        runningCostUsd: budget.getCurrentCost(),
      });
    }

    const reportJson = JSON.stringify({
      calls: report,
      cacheSavings: budget.getCacheSavingsSummary(),
    }, null, 2);
    // eslint-disable-next-line no-console
    console.log('DOGFOOD-REPORT', reportJson);
    if (process.env.DOGFOOD_REPORT_FILE) {
      fs.writeFileSync(process.env.DOGFOOD_REPORT_FILE, reportJson);
    }

    expect(budget.getCurrentCost()).toBeGreaterThan(0);
  }, 120_000);
});
