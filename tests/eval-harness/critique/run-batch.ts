/**
 * Critique batch eval runner — offline.
 *
 * 用法（worktree 根目录）：
 *   set -a; source .env; set +a   # 加载 .env 到 shell
 *   HTTPS_PROXY=http://127.0.0.1:7897 npx tsx tests/eval-harness/critique/run-batch.ts
 *
 * 环境变量：
 *   MOONSHOT_API_KEY (必需) — primary 判官 (Kimi)
 *   DEEPSEEK_API_KEY (可选) — secondary 判官；缺失则跳过 cross-check
 *   CRITIQUE_PRIMARY_MODEL (可选) — override moonshot defaultModel
 *   CRITIQUE_PRIMARY_ENDPOINT (可选) — override moonshot endpoint（如切到 KIMI_K25 走 api.kimi.com/coding/v1）
 *   CRITIQUE_SECONDARY_MODEL (可选) — override deepseek defaultModel
 *   CRITIQUE_SECONDARY_ENDPOINT (可选) — override deepseek endpoint
 *   CRITIQUE_FORMAT=json|md (默认 json)
 *   CRITIQUE_OUT_FILE (可选) — 写入文件，缺失则 stdout
 */
import { writeFileSync } from 'fs';
import { PROVIDER_REGISTRY } from '../../../src/shared/constants/providers';
import { runBatch, renderBatchMarkdown } from './batch';
import { CASES } from './cases';
import { createOpenAICompatibleCaller } from './caller';

interface Env {
  primaryKey: string;
  primaryModel: string;
  primaryEndpoint: string;
  secondaryKey?: string;
  secondaryModel?: string;
  secondaryEndpoint?: string;
  format: 'json' | 'md';
  outFile?: string;
}

function readEnv(): Env {
  const primaryKey = process.env.MOONSHOT_API_KEY;
  if (!primaryKey) {
    throw new Error('run-batch: MOONSHOT_API_KEY is required (primary judge)');
  }
  const moonshot = PROVIDER_REGISTRY.moonshot;
  const deepseek = PROVIDER_REGISTRY.deepseek;
  const env: Env = {
    primaryKey,
    primaryModel: process.env.CRITIQUE_PRIMARY_MODEL ?? moonshot.defaultModel,
    primaryEndpoint: process.env.CRITIQUE_PRIMARY_ENDPOINT ?? moonshot.endpoint,
    format: process.env.CRITIQUE_FORMAT === 'md' ? 'md' : 'json',
    outFile: process.env.CRITIQUE_OUT_FILE,
  };
  if (process.env.DEEPSEEK_API_KEY) {
    env.secondaryKey = process.env.DEEPSEEK_API_KEY;
    env.secondaryModel = process.env.CRITIQUE_SECONDARY_MODEL ?? deepseek.defaultModel;
    env.secondaryEndpoint = process.env.CRITIQUE_SECONDARY_ENDPOINT ?? deepseek.endpoint;
  }
  return env;
}

async function main(): Promise<void> {
  const env = readEnv();

  const primaryCaller = createOpenAICompatibleCaller({
    apiKey: env.primaryKey,
    endpoint: env.primaryEndpoint,
    model: env.primaryModel,
  });
  const secondaryCaller = env.secondaryKey
    ? createOpenAICompatibleCaller({
        apiKey: env.secondaryKey,
        endpoint: env.secondaryEndpoint!,
        model: env.secondaryModel!,
      })
    : undefined;

  const report = await runBatch(CASES, {
    primary: { judge: env.primaryModel, caller: primaryCaller },
    secondary: secondaryCaller
      ? { judge: env.secondaryModel!, caller: secondaryCaller }
      : undefined,
  });

  const output = env.format === 'md' ? renderBatchMarkdown(report) : JSON.stringify(report, null, 2);
  if (env.outFile) {
    writeFileSync(env.outFile, output, 'utf-8');
    console.error(`run-batch: wrote ${env.format} report to ${env.outFile}`);
  } else {
    process.stdout.write(output + (env.format === 'json' ? '\n' : ''));
  }
}

main().catch((err) => {
  console.error('run-batch failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
