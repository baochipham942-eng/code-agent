#!/usr/bin/env npx tsx
// N-FIX-FG-BASH-NARROWED-BY-RUN-POLICY：真实模型回放点名命令工具的前台分诊。
// 用法：set -a; source ~/.code-agent/.env; set +a
//       npx tsx scripts/acceptance/fg-bash-named-real.ts
//       npx tsx scripts/acceptance/fg-bash-named-real.ts --provider xiaomi
//       npx tsx scripts/acceptance/fg-bash-named-real.ts --expect-after
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { ToolSchema } from '../../src/host/protocol/tools';
import { STEPFUN_TIER, ZHIPU_CODING_TIER } from './_jev-real-sites-lib';

const ROUNDS = 3;
const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 8192;
const CALL_TIMEOUT_MS = 180_000;
const MAX_MODEL_STEPS = 4;

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
type Provider = 'xiaomi' | 'zhipu' | 'stepfun';

interface ReplayTier {
  model: string;
  baseUrl: string;
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface AssistantMessage {
  content?: unknown;
  tool_calls?: ToolCall[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface RoundResult {
  disabledWording: boolean;
  disabledMatches: string[];
  delegateTaskCalls: number;
  connectorCalls: number;
  remindersCreateCalls: number;
  backgroundNotice: boolean;
}

interface PromptTotals {
  disabledWording: number;
  delegateTaskCalls: number;
  connectorCalls: number;
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
  ['缺少 Bash', /没有[^。.!！?？\n]{0,16}Bash[^。.!！?？\n]{0,8}工具|Bash[^。.!！?？\n]{0,8}工具[^。.!！?？\n]{0,16}没有/i],
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

function score(messages: AssistantMessage[]): RoundResult {
  const text = messages.map((message) => (
    typeof message.content === 'string'
      ? message.content
      : message.content == null ? '' : JSON.stringify(message.content)
  )).join('\n');
  const toolCalls = messages.flatMap((message) => (
    Array.isArray(message.tool_calls) ? message.tool_calls : []
  ));
  const disabledMatches = DISABLED_WORDING
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  return {
    disabledWording: disabledMatches.length > 0,
    disabledMatches,
    delegateTaskCalls: toolCalls.filter((call) => call.function?.name === 'delegate_task').length,
    connectorCalls: toolCalls.filter((call) => call.function?.name === 'reminders'
      || call.function?.name?.startsWith('reminders_')).length,
    remindersCreateCalls: toolCalls.filter((call) => call.function?.name === 'reminders_create').length,
    backgroundNotice: /后台(?:任务)?[^。.!！?？\n]{0,32}(?:运行|执行|开始|处理)|(?:正在|已经|已)[^。.!！?？\n]{0,32}后台/.test(text),
  };
}

async function chatCall(
  apiKey: string,
  provider: Provider,
  tier: ReplayTier,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>>,
  toolChoice: 'auto' | 'required',
): Promise<AssistantMessage> {
  const response = await fetch(`${tier.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: tier.model,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(provider === 'xiaomi' ? { thinking: { type: 'disabled' } } : {}),
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

function replayToolOutput(call: ToolCall): string {
  const name = call.function?.name;
  if (name === 'delegate_task') {
    return 'accepted：后台任务「回放」(replay-task) 已开始。accepted 不等于完成；结果只以后续任务终态回流为准。';
  }
  if (name === 'reminders') {
    return JSON.stringify({ ok: true, lists: ['提醒事项'], reminders: [] });
  }
  if (name === 'reminders_create') {
    return JSON.stringify({ ok: true, list: '提醒事项', title: '交报告', status: 'created' });
  }
  return JSON.stringify({ ok: false, code: 'REPLAY_UNSUPPORTED_TOOL', tool: name ?? 'unknown' });
}

async function runRound(
  apiKey: string,
  provider: Provider,
  tier: ReplayTier,
  prompt: string,
  tools: Array<Record<string, unknown>>,
  forceToolOnFirstStep: boolean,
): Promise<AssistantMessage[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: getSessionCommandCenterBrainContextForPrompt(prompt).join('\n') },
    { role: 'user', content: prompt },
  ];
  const assistantMessages: AssistantMessage[] = [];
  for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
    const message = await chatCall(
      apiKey,
      provider,
      tier,
      messages,
      tools,
      forceToolOnFirstStep && step === 0 ? 'required' : 'auto',
    );
    assistantMessages.push(message);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) break;
    messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      tool_calls: toolCalls,
    });
    for (const [index, call] of toolCalls.entries()) {
      messages.push({
        role: 'tool',
        content: replayToolOutput(call),
        tool_call_id: call.id ?? `replay-${step}-${index}`,
      });
    }
  }
  return assistantMessages;
}

async function runPrompt(
  apiKey: string,
  provider: Provider,
  tier: ReplayTier,
  prompt: typeof PROMPTS[number],
): Promise<PromptTotals> {
  const totals: PromptTotals = {
    disabledWording: 0,
    delegateTaskCalls: 0,
    connectorCalls: 0,
    remindersCreateCalls: 0,
    backgroundNotice: 0,
  };
  const tools = wireTools(prompt.text);
  // P3 compares connector routing with delegate_task; require its first action so a text-only
  // success claim cannot masquerade as either route. Follow-up turns return to normal auto choice.
  const forceToolOnFirstStep = prompt.id === 'P3';
  if (forceToolOnFirstStep) console.log(`TOOL_CHOICE prompt=${prompt.id} first_step=required later_steps=auto`);
  for (let round = 1; round <= ROUNDS; round += 1) {
    const messages = await runRound(apiKey, provider, tier, prompt.text, tools, forceToolOnFirstStep);
    const result = score(messages);
    totals.disabledWording += Number(result.disabledWording);
    totals.delegateTaskCalls += result.delegateTaskCalls;
    totals.connectorCalls += result.connectorCalls;
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
      `connector_calls=${result.connectorCalls}`,
      `reminders_create_calls=${result.remindersCreateCalls}`,
      `background_notice=${Number(result.backgroundNotice)}`,
      `assistant_messages=${JSON.stringify(messages)}`,
      `tool_calls=${JSON.stringify(messages.flatMap((message) => message.tool_calls ?? []))}`,
    ].join(' '));
  }
  console.log(`SUMMARY provider=${provider} prompt=${prompt.id} rounds=${ROUNDS} disabled_wording=${totals.disabledWording} delegate_task=${totals.delegateTaskCalls} connector_calls=${totals.connectorCalls} reminders_create=${totals.remindersCreateCalls} background_notice=${totals.backgroundNotice}`);
  return totals;
}

function parseArgs(argv: string[]): { provider: Provider; expectAfter: boolean } {
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex === -1 ? 'xiaomi' : argv[providerIndex + 1];
  if (provider !== 'xiaomi' && provider !== 'zhipu' && provider !== 'stepfun') {
    throw new Error('--provider must be xiaomi, zhipu, or stepfun');
  }
  const known = new Set(['--provider', 'xiaomi', 'zhipu', 'stepfun', '--expect-after']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(', ')}`);
  return { provider, expectAfter: argv.includes('--expect-after') };
}

function afterFailures(results: Record<PromptId, PromptTotals>): string[] {
  const failures: string[] = [];
  for (const id of ['P1', 'P2'] as const) {
    if (results[id].disabledWording !== 0) failures.push(`${id}: disabled wording`);
    if (results[id].delegateTaskCalls !== ROUNDS) failures.push(`${id}: delegate_task ${results[id].delegateTaskCalls}/${ROUNDS}`);
    if (results[id].backgroundNotice !== ROUNDS) failures.push(`${id}: background notice ${results[id].backgroundNotice}/${ROUNDS}`);
  }
  if (results.P3.connectorCalls < ROUNDS) failures.push(`P3: connector calls ${results.P3.connectorCalls}/${ROUNDS}`);
  if (results.P3.delegateTaskCalls !== 0) failures.push(`P3: delegate_task ${results.P3.delegateTaskCalls}`);
  return failures;
}

async function main(): Promise<void> {
  const { provider, expectAfter } = parseArgs(process.argv.slice(2));
  const xiaomiBaseUrl = (process.env.XIAOMI_API_URL ?? '').trim().replace(/\/+$/, '');
  const tier: ReplayTier = provider === 'xiaomi'
    ? { model: 'mimo-v2.6-flash', baseUrl: xiaomiBaseUrl }
    : provider === 'zhipu' ? ZHIPU_CODING_TIER : STEPFUN_TIER;
  const keyEnv = provider === 'xiaomi'
    ? 'XIAOMI_API_KEY'
    : provider === 'zhipu' ? 'ZHIPU_CODING_API_KEY' : 'STEPFUN_API_KEY';
  if (!tier.baseUrl) throw new Error('XIAOMI_API_URL is required for the xiaomi replay');
  const apiKey = (process.env[keyEnv] ?? '').trim();
  if (!apiKey) throw new Error(`${keyEnv} is required; refusing to skip the real-model replay`);
  await loadProductModules();
  console.log(`REPLAY provider=${provider} model=${tier.model} endpoint=${tier.baseUrl} temperature=${TEMPERATURE} rounds=${ROUNDS} thinking=${provider === 'xiaomi' ? 'disabled' : 'provider-default'} reminders_config=in-process-enabled`);
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
