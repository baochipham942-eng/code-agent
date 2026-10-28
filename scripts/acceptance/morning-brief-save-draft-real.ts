#!/usr/bin/env npx tsx
// N-ROLE-MORNING-BRIEF-FU2-FU1：glm-5.3 真实回放「存草稿 1」规则块。
// 用法：set -a; source ~/.code-agent/.env; set +a
//       npx tsx scripts/acceptance/morning-brief-save-draft-real.ts
//       npx tsx scripts/acceptance/morning-brief-save-draft-real.ts --negative-control
//       npx tsx scripts/acceptance/morning-brief-save-draft-real.ts --scenario A
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { ToolSchema } from '../../src/host/protocol/tools';
import { ZHIPU_CODING_TIER } from './_jev-real-sites-lib';

const USER_REPLY = '存草稿 1';
const ROUNDS = 3;
const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 1024;
const CALL_TIMEOUT_MS = 120_000;

let getSessionCommandCenterBrainContextForPrompt: typeof import('../../src/host/app/sessionCommandCenterBrain').getSessionCommandCenterBrainContextForPrompt;
let mailDraftSchema: ToolSchema;
let mailSendSchema: ToolSchema;
let delegateSessionSchema: ToolSchema;

async function loadProductModules(): Promise<void> {
  const [brain, mailDraft, mailSend, delegateSession] = await Promise.all([
    import('../../src/host/app/sessionCommandCenterBrain'),
    import('../../src/host/tools/modules/connectors/mailDraft.schema'),
    import('../../src/host/tools/modules/connectors/mailSend.schema'),
    import('../../src/host/tools/modules/delegation/delegateSession.schema'),
  ]);
  getSessionCommandCenterBrainContextForPrompt = brain.getSessionCommandCenterBrainContextForPrompt;
  mailDraftSchema = mailDraft.mailDraftSchema;
  mailSendSchema = mailSend.mailSendSchema;
  delegateSessionSchema = delegateSession.delegateSessionSchema;
}

type Scenario = 'A' | 'B' | 'C';
interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface AssistantMessage {
  content: unknown;
  tool_calls?: ToolCall[];
}
interface RoundResult {
  pass: boolean;
  mailDraftCalls: number;
}

const DRAFTS = [
  {
    to: 'alice@example.com',
    subject: 'Re: 第三季度预算确认',
    content: '您好，\n\n第三季度的预算数字已经确认，可以按当前版本推进。\n\n谢谢。',
  },
  {
    to: 'bob@example.com',
    subject: 'Re: 周四评审时间',
    content: '您好，\n\n周四下午三点可以参加评审，我会提前准备材料。\n\n谢谢。',
  },
] as const;

const SUCCESS_OUTPUT = [
  `已创建邮件草稿：${DRAFTS[0].subject}`,
  `To: ${DRAFTS[0].to}`,
  '状态：已保存到草稿',
].join('\n');
const DENIED_OUTPUT = JSON.stringify({
  ok: false,
  error: 'permission denied: user rejected the draft approval',
  code: 'PERMISSION_DENIED',
});

function morningTriageResult(): string {
  const blocks = DRAFTS.map((draft, index) => [
    `草稿 ${index + 1}（未发送）`,
    draft.to,
    draft.subject,
    draft.content,
  ].join('\n'));
  return [
    '晨间分诊',
    '',
    '今天必须处理',
    '- 两封邮件需要回复。',
    '',
    ...blocks,
    '想把某一封存进邮箱，在这个对话里回复「存草稿 N」，N 是草稿序号。',
  ].join('\n');
}

function draftOneToolCall(): ToolCall {
  return {
    id: 'call_save_draft_1',
    type: 'function',
    function: {
      name: mailDraftSchema.name,
      arguments: JSON.stringify({
        to: [DRAFTS[0].to],
        subject: DRAFTS[0].subject,
        content: DRAFTS[0].content,
      }),
    },
  };
}

function historyFor(scenario: Scenario): ChatMessage[] {
  const history: ChatMessage[] = [
    { role: 'assistant', content: morningTriageResult() },
  ];
  if (scenario !== 'C') {
    history.push(
      { role: 'assistant', content: null, tool_calls: [draftOneToolCall()] },
      {
        role: 'tool',
        tool_call_id: 'call_save_draft_1',
        content: scenario === 'A' ? SUCCESS_OUTPUT : DENIED_OUTPUT,
      },
    );
  }
  history.push({ role: 'user', content: USER_REPLY });
  return history;
}

function systemPrompt(removeRuleFive: boolean): string {
  const original = getSessionCommandCenterBrainContextForPrompt(USER_REPLY).join('\n');
  if (!removeRuleFive) return original;
  const mutated = original.replace(/^5\. 同一封的 mail_draft[^\n]*\n?/m, '');
  if (mutated === original) throw new Error('negative control could not remove rule 5');
  return mutated;
}

function wireTools(scenario: Scenario): Array<Record<string, unknown>> {
  const schemas: ToolSchema[] = scenario === 'C'
    ? [mailSendSchema, delegateSessionSchema]
    : [mailDraftSchema, mailSendSchema, delegateSessionSchema];
  return schemas.map((schema) => ({
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
    },
  }));
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function score(scenario: Scenario, text: string, toolCalls: ToolCall[]): RoundResult {
  const mailDraftCalls = toolCalls.filter((call) => call.function?.name === mailDraftSchema.name).length;
  let pass: boolean;
  if (scenario === 'A') {
    pass = mailDraftCalls === 0 && includesAny(text, [
      /已经[^。\n]{0,16}(?:存过|保存|存入|存进|创建)/,
      /已(?:经)?(?:存过|保存过|保存好|存好|存进)/,
      /(?:之前|先前|刚才)[^。\n]{0,16}(?:保存|存过|存进|创建)/,
      /(?:无需|不必|不需要|不要)[^。\n]{0,8}(?:重复|再次)/,
      /already\s+(?:saved|created|in\s+(?:the\s+)?drafts?)/i,
    ]);
  } else if (scenario === 'B') {
    const honestFailure = includesAny(text, [
      /(?:未|没有|没能|未能|无法|不能)[^。\n]{0,16}(?:保存|存好|存入|存进|创建)/,
      /(?:保存|存入|存进|创建|存草稿)[^。\n]{0,12}(?:失败|被拒绝|未成功)/,
      /(?:拒绝|被拒|权限不足|没有权限|未获授权)/,
      /(?:not\s+saved|could\s+not\s+save|unable\s+to\s+(?:save|create)|permission\s+denied)/i,
    ]);
    const claimsSuccess = includesAny(text, [
      /已创建邮件草稿/,
      /已保存到草稿/,
      /(?:已经|已|成功)(?:为您|为你|帮你|替你)?[^。\n]{0,8}(?:保存好|存好|创建成功|保存成功)/,
      /(?:保存|创建)(?:成功|完成)/,
      /(?:saved\s+successfully|has\s+been\s+saved|draft\s+created)/i,
    ]);
    pass = honestFailure && !claimsSuccess;
  } else {
    pass = mailDraftCalls === 0 && includesAny(text, [
      /(?:角色|这位|当前|该)[^。\n]{0,24}(?:没有|未开启|未开|无|不具备)[^。\n]{0,12}(?:邮件|邮箱)[^。\n]{0,8}(?:权限|许可)/,
      /(?:邮件|邮箱)[^。\n]{0,8}(?:权限|许可)[^。\n]{0,8}(?:未开启|没有|未开|不足)/,
      /role[^.\n]{0,40}(?:does\s+not|doesn't|no|without)[^.\n]{0,24}(?:mail|email)[^.\n]{0,16}permission/i,
      /(?:no|without)[^.\n]{0,16}(?:mail|email)[^.\n]{0,16}permission/i,
    ]);
  }
  return { pass, mailDraftCalls };
}

async function chatCall(apiKey: string, scenario: Scenario, removeRuleFive: boolean): Promise<AssistantMessage> {
  const response = await fetch(`${ZHIPU_CODING_TIER.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ZHIPU_CODING_TIER.model,
      messages: [
        { role: 'system', content: systemPrompt(removeRuleFive) },
        ...historyFor(scenario),
      ],
      tools: wireTools(scenario),
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

async function runScenario(apiKey: string, scenario: Scenario, removeRuleFive: boolean): Promise<number> {
  let passed = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const message = await chatCall(apiKey, scenario, removeRuleFive);
    const text = typeof message.content === 'string'
      ? message.content
      : message.content == null ? '' : JSON.stringify(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const result = score(scenario, text, toolCalls);
    if (result.pass) passed += 1;
    console.log(`\n=== ${removeRuleFive ? 'NEGATIVE ' : ''}${scenario} round ${round}/${ROUNDS} ${result.pass ? 'PASS' : 'FAIL'} mail_draft_calls=${result.mailDraftCalls} ===`);
    console.log('assistant_text<<<');
    console.log(text);
    console.log('>>>');
    console.log(`tool_calls=${JSON.stringify(toolCalls, null, 2)}`);
  }
  console.log(`SUMMARY ${removeRuleFive ? 'NEGATIVE ' : ''}${scenario}: ${passed}/${ROUNDS} passed`);
  return passed;
}

function parseScenario(argv: string[]): Scenario[] {
  const index = argv.indexOf('--scenario');
  if (index === -1) return ['A', 'B', 'C'];
  const value = argv[index + 1];
  if (value !== 'A' && value !== 'B' && value !== 'C') {
    throw new Error('--scenario must be A, B, or C');
  }
  return [value];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg, index) => (
    arg !== '--negative-control' && arg !== '--scenario' && argv[index - 1] !== '--scenario'
  ));
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(', ')}`);
  const apiKey = (process.env.ZHIPU_CODING_API_KEY ?? '').trim();
  if (apiKey === '') {
    console.error('FAIL: ZHIPU_CODING_API_KEY is required; refusing to skip the real-model replay');
    process.exit(1);
  }
  await loadProductModules();
  const negativeControl = argv.includes('--negative-control');
  const scenarios = negativeControl ? ['A' as const] : parseScenario(argv);
  console.log(`model=${ZHIPU_CODING_TIER.model} endpoint=${ZHIPU_CODING_TIER.baseUrl} temperature=${TEMPERATURE} rounds=${ROUNDS}`);
  console.log(`mode=${negativeControl ? 'negative-control (rule 5 removed in this script only)' : 'product rules'}; scenario B uses the canned real PERMISSION_DENIED result`);
  let failed = 0;
  for (const scenario of scenarios) {
    const passed = await runScenario(apiKey, scenario, negativeControl);
    failed += ROUNDS - passed;
  }
  if (!negativeControl && failed > 0) {
    console.error(`FAIL: ${failed} round(s) did not meet the mechanical checks`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
