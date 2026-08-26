#!/usr/bin/env npx tsx

import path from 'node:path';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { buildPrompt } from '../../src/host/prompts/builder';
import { OpenAIProvider } from '../../src/host/model/providers/openaiProvider';
import { MoonshotProvider } from '../../src/host/model/providers/moonshotProvider';
import { DeepSeekProvider } from '../../src/host/model/providers/deepseekProvider';
import { askUserQuestionSchema } from '../../src/host/tools/modules/planning/askUserQuestion.schema';
import { tmeetMeetingCreateSchema } from '../../src/host/tools/modules/connectors/tmeetMeetingCreate.schema';
import type { ModelConfig, ToolDefinition } from '../../src/shared/contract';
import type { Provider } from '../../src/host/model/types';

const TRIALS_PER_ARM = 3;
const PROMPT = '创建一场会议，马上开始';

type Arm = 'production' | 'mutation';

interface TrialResult {
  sequence: number;
  arm: Arm;
  tool: string;
  finishReason?: string;
}

loadDotenv({ path: path.join(process.cwd(), '.env'), quiet: true });
loadDotenv({ path: path.join(process.env.HOME ?? '', '.code-agent', '.env'), quiet: true });

function mutationPrompt(): string {
  return buildPrompt().replace(
    /<writeback_one_card>[\s\S]*?<\/writeback_one_card>/u,
    '',
  );
}

function mutationAskDescription(): string {
  return 'Asks the user a question and waits for their response. '
    + 'Use when you need clarification, confirmation, or additional information to proceed. '
    + 'Do NOT use this for simple status updates — just output text directly.';
}

function toolsForArm(arm: Arm): ToolDefinition[] {
  const ask = {
    ...askUserQuestionSchema,
    description: arm === 'production'
      ? askUserQuestionSchema.description
      : mutationAskDescription(),
  } as ToolDefinition;
  return [ask, tmeetMeetingCreateSchema as ToolDefinition];
}

function countByTool(results: TrialResult[], arm: Arm): Record<string, number> {
  return results
    .filter((trial) => trial.arm === arm)
    .reduce<Record<string, number>>((counts, trial) => {
      counts[trial.tool] = (counts[trial.tool] ?? 0) + 1;
      return counts;
    }, {});
}

async function main(): Promise<void> {
  if (process.env.WRITEBACK_ONECARD_REAL_EVAL !== '1') {
    throw new Error('Set WRITEBACK_ONECARD_REAL_EVAL=1 to acknowledge six paid real-model calls.');
  }

  const providerName = process.env.WRITEBACK_ONECARD_REAL_EVAL_PROVIDER?.trim() || 'openai';
  const providerConfig: Record<string, { apiKey: string | undefined; defaultModel: string; create: () => Provider }> = {
    openai: {
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      defaultModel: 'gpt-4o-mini',
      create: () => new OpenAIProvider(),
    },
    moonshot: {
      apiKey: (process.env.KIMI_K25_API_KEY || process.env.MOONSHOT_API_KEY)?.trim(),
      defaultModel: 'kimi-k2.5',
      create: () => new MoonshotProvider(),
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY?.trim(),
      defaultModel: 'deepseek-chat',
      create: () => new DeepSeekProvider(),
    },
  };
  const selected = providerConfig[providerName];
  if (!selected) throw new Error(`Unsupported provider: ${providerName}`);
  if (!selected.apiKey) throw new Error(`API key is required for ${providerName}.`);

  const model = process.env.WRITEBACK_ONECARD_REAL_EVAL_MODEL?.trim() || selected.defaultModel;
  const provider = selected.create();
  const config: ModelConfig = {
    provider: providerName,
    model,
    apiKey: selected.apiKey,
    temperature: providerName === 'moonshot' ? 1 : providerName === 'deepseek' ? 0.7 : 0,
    maxTokens: providerName === 'moonshot' ? 1024 : 256,
  };
  const results: TrialResult[] = [];

  for (let index = 0; index < TRIALS_PER_ARM; index += 1) {
    for (const arm of ['production', 'mutation'] as const) {
      const response = await provider.inference(
        [
          {
            role: 'system',
            content: arm === 'production' ? buildPrompt() : mutationPrompt(),
          },
          { role: 'user', content: PROMPT },
        ],
        toolsForArm(arm),
        config,
        undefined,
        undefined,
        {
          forceNonStreaming: true,
          disableProviderTransientRetry: true,
          requestTimeoutMs: 45_000,
          maxOutputTokens: providerName === 'moonshot' ? 1024 : 256,
        },
      );
      results.push({
        sequence: results.length + 1,
        arm,
        tool: response.toolCalls?.[0]?.name ?? '(no tool call)',
        finishReason: response.finishReason,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    prompt: PROMPT,
    provider: providerName,
    model,
    pattern: results.map((trial) => trial.arm === 'production' ? 'A' : 'B').join(''),
    trialsPerArm: TRIALS_PER_ARM,
    results,
    summary: {
      production: countByTool(results, 'production'),
      mutation: countByTool(results, 'mutation'),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
