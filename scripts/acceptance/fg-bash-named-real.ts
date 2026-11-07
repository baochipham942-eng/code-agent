#!/usr/bin/env npx tsx
// N-FIX-FG-BASH-NARROWED-BY-RUN-POLICY：真实模型回放点名命令工具的前台分诊。
// 用法：set -a; source ~/.code-agent/.env; set +a
//       npx tsx scripts/acceptance/fg-bash-named-real.ts
//       npx tsx scripts/acceptance/fg-bash-named-real.ts --provider stepfun
//       npx tsx scripts/acceptance/fg-bash-named-real.ts --expect-after
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { ToolSchema } from '../../src/host/protocol/tools';
import { STEPFUN_TIER, ZHIPU_CODING_TIER } from './_jev-real-sites-lib';

const ROUNDS = 3;
const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 2048;
const CALL_TIMEOUT_MS = 180_000;

const PROMPTS = [
  {
    id: 'P1',
    text: '明天上午 9 点提醒我交报告。请用 Bash 工具执行多行 osascript（heredoc）建提醒',
  },
  {
    id: 'P2',
    text: '请用 Bash 运行测试：npm run -s typecheck && npx vitest run tests/unit/app',
  },
  {
    id: 'P3',
    text: '明天上午 9 点提醒我交报告',
  },
] as const;

type PromptId = typeof PROMPTS[number]['id'];
type Provider = 'zhipu' | 'stepfun';

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface AssistantMessage {
  content?: unknown;
  tool_calls?: ToolCall[];
}

interface RoundResult {
  disabledWording: boolean;
  disabledMatches: string[];
  delegateTaskCalls: number;
  remindersCreateCalls: number;
  backgroundNotice: boolean;
}

interface PromptTotals {
  disabledWording: number;
  delegateTaskCalls: number;
  remindersCreateCalls: number;
  backgroundNotice: number;
}

const DISABLED_WORDING = [
  ['disabled', /\bdisabled\b/i],
  ['not available', /\bnot\s+available\b/i],
  ['unavailable', /\bunavailable\b/i],
  ['no permission', /\bno\s+permission\b/i],
  ['permission denied', /\bpermission\s+denied\b/i],
  ['禁用', /禁用|被禁|已禁/],
  ['不可用', /不可用/],
  ['无法使用', /无法使用|不能使用/],
  ['没有权限', /没有权限|无权限|权限不足/],
  ['环境受限', /环境受限|环境限制/],
] as const;

let getSessionCommandCenterBrainContextForPrompt: typeof import('../../src/host/app/sessionCommandCenterBrain').getSessionCommandCenterBrainContextForPrompt;
let getTextForegroundToolNamesForPrompt: typeof import('../../src/host/app/sessionCommandCenterBrain').getTextForegroundToolNamesForPrompt;
let getProtocolRegistry: typeof import('../../src/host/tools/protocolRegistry').getProtocolRegistry;

async function loadProductModules(): Promise<void> {
  const [{ getConfigService }, { replayNativeConnectors }] = await Promise.all([
    import('../../src/host/services/core/configService'),
    import('../../src/host/connectors/replay'),
  ]);
  const configService = getConfigService();
  const settings = configService.getSettings();
  const enabledNative = Array.from(new Set([
    ...(settings.connectors?.enabledNative ?? []),
    'reminders',
  ]));
  // 回放只在当前进程模拟「提醒事项已启用」，不写用户设置；P3 因而能验证 3a 的直调路径。
  configService.getSettings = () => ({
    ...settings,
    connectors: { ...settings.connectors, enabledNative },
  });
  replayNativeConnectors(configService);

  const [brain, registry] = await Promise.all([
    import('../../src/host/app/sessionCommandCenterBrain'),
    import('../../src/host/tools/protocolRegistry'),
  ]);
  getSessionCommandCenterBrainContextForPrompt = brain.getSessionCommandCenterBrainContextForPrompt;
  getTextForegroundToolNamesForPrompt = brain.getTextForegroundToolNamesForPrompt;
  getProtocolRegistry = registry.getProtocolRegistry;
}

function wireTools(prompt: string): Array<Record<string, unknown>> {
  const allowedNames = new Set([
    ...getTextForegroundToolNamesForPrompt(prompt),
    'delegate_task',
  ]);
  const schemas = getProtocolRegistry().getSchemas()
    .filter((schema) => allowedNames.has(schema.name));
  const wiredNames = new Set(schemas.map((schema) => schema.name));
  for (const required of ['delegate_task', ...(prompt === PROMPTS[2].text ? ['reminders_create'] : [])]) {
    if (!wiredNames.has(required)) throw new Error(`required replay tool is missing: ${required}`);
  }
  console.log(`TOOLS prompt=${PROMPTS.find((candidate) => candidate.text === prompt)?.id ?? '?'} names=${JSON.stringify(schemas.map((schema) => schema.name))}`);
  return schemas.map(toWireTool);
}

function toWireTool(schema: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
    },
  };
}

function score(message: AssistantMessage): RoundResult {
  const text = typeof message.content === 'string'
    ? message.content
    : message.content == null ? '' : JSON.stringify(message.content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const disabledMatches = DISABLED_WORDING
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  return {
    disabledWording: disabledMatches.length > 0,
    disabledMatches,
    delegateTaskCalls: toolCalls.filter((call) => call.function?.name === 'delegate_task').length,
    remindersCreateCalls: toolCalls.filter((call) => call.function?.name === 'reminders_create').length,
    backgroundNotice: /后台(?:任务)?[^。.!！?？\n]{0,32}(?:运行|执行|开始|处理)|(?:正在|已经|已)[^。.!！?？\n]{0,32}后台/.test(text),
  };
}

async function chatCall(
  apiKey: string,
  tier: typeof ZHIPU_CODING_TIER | typeof STEPFUN_TIER,
  prompt: string,
): Promise<AssistantMessage> {
  const response = await fetch(`${tier.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: tier.model,
      messages: [
        { role: 'system', content: getSessionCommandCenterBrainContextForPrompt(prompt).join('\n') },
        { role: 'user', content: prompt },
      ],
      tools: wireTools(prompt),
      tool_choice: 'auto',
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: AssistantMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error(`response has no assistant message: ${JSON.stringify(payload)}`);
  return message;
}

async function runPrompt(
  apiKey: string,
  provider: Provider,
  tier: typeof ZHIPU_CODING_TIER | typeof STEPFUN_TIER,
  prompt: typeof PROMPTS[number],
): Promise<PromptTotals> {
  const totals: PromptTotals = {
    disabledWording: 0,
    delegateTaskCalls: 0,
    remindersCreateCalls: 0,
    backgroundNotice: 0,
  };
  for (let round = 1; round <= ROUNDS; round += 1) {
    const message = await chatCall(apiKey, tier, prompt.text);
    const result = score(message);
    totals.disabledWording += Number(result.disabledWording);
    totals.delegateTaskCalls += result.delegateTaskCalls;
    totals.remindersCreateCalls += result.remindersCreateCalls;
    totals.backgroundNotice += Number(result.backgroundNotice);
    console.log([
      'RAW',
      `provider=${provider}`,
      `prompt=${prompt.id}`,
      `round=${round}`,
      `disabled_wording=${Number(result.disabledWording)}`,
      `disabled_matches=${JSON.stringify(result.disabledMatches)}`,
      `delegate_task_calls=${result.delegateTaskCalls}`,
      `reminders_create_calls=${result.remindersCreateCalls}`,
      `background_notice=${Number(result.backgroundNotice)}`,
      `assistant_text=${JSON.stringify(message.content ?? '')}`,
      `tool_calls=${JSON.stringify(message.tool_calls ?? [])}`,
    ].join(' '));
  }
  console.log(`SUMMARY provider=${provider} prompt=${prompt.id} rounds=${ROUNDS} disabled_wording=${totals.disabledWording} delegate_task=${totals.delegateTaskCalls} reminders_create=${totals.remindersCreateCalls} background_notice=${totals.backgroundNotice}`);
  return totals;
}

function parseArgs(argv: string[]): { provider: Provider; expectAfter: boolean } {
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex === -1 ? 'zhipu' : argv[providerIndex + 1];
  if (provider !== 'zhipu' && provider !== 'stepfun') {
    throw new Error('--provider must be zhipu or stepfun');
  }
  const known = new Set(['--provider', 'zhipu', 'stepfun', '--expect-after']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(', ')}`);
  return { provider, expectAfter: argv.includes('--expect-after') };
}

function afterFailures(results: Record<PromptId, PromptTotals>): string[] {
  const failures: string[] = [];
  for (const id of ['P1', 'P2'] as const) {
    if (results[id].disabledWording !== 0) failures.push(`${id}: disabled wording`);
    if (results[id].delegateTaskCalls !== ROUNDS) failures.push(`${id}: delegate_task ${results[id].delegateTaskCalls}/${ROUNDS}`);
  }
  if (results.P3.remindersCreateCalls !== ROUNDS) failures.push(`P3: reminders_create ${results.P3.remindersCreateCalls}/${ROUNDS}`);
  if (results.P3.delegateTaskCalls !== 0) failures.push(`P3: delegate_task ${results.P3.delegateTaskCalls}`);
  return failures;
}

async function main(): Promise<void> {
  const { provider, expectAfter } = parseArgs(process.argv.slice(2));
  const tier = provider === 'zhipu' ? ZHIPU_CODING_TIER : STEPFUN_TIER;
  const keyEnv = provider === 'zhipu' ? 'ZHIPU_CODING_API_KEY' : 'STEPFUN_API_KEY';
  const apiKey = (process.env[keyEnv] ?? '').trim();
  if (!apiKey) throw new Error(`${keyEnv} is required; refusing to skip the real-model replay`);
  await loadProductModules();
  console.log(`REPLAY provider=${provider} model=${tier.model} endpoint=${tier.baseUrl} temperature=${TEMPERATURE} rounds=${ROUNDS} reminders_config=in-process-enabled`);
  const results = {} as Record<PromptId, PromptTotals>;
  for (const prompt of PROMPTS) results[prompt.id] = await runPrompt(apiKey, provider, tier, prompt);
  if (expectAfter) {
    const failures = afterFailures(results);
    if (failures.length > 0) throw new Error(`after expectations failed: ${failures.join('; ')}`);
    console.log('AFTER_EXPECTATIONS PASS');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
