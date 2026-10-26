#!/usr/bin/env npx tsx
// ============================================================================
// N-ROLE-PROACTIVITY-CHAT-TUNE ③ —— set_role_proactivity 真模型验收。
//
// 真实 schema（直接 import 仓内 schema 文件）+ stub 审批（模型调用工具即视为
// 用户已允许，回放真实工具的输出文案），对 GLM coding 端点 glm-5.3 跑脚本化
// 工具循环，各 3 轮：
//   A「以后每天只跟我说一次，别报天气」→ 期望 set_role_proactivity 调用带
//     once_a_day=true + add_exclude 含「天气」（不出现 silent）
//   B「少烦我」→ 期望不出现 level=silent 的调用，且给出澄清式提问
//     （ask_user_question 或正文问句）
// 失败照实报数，不粉饰；key 取 ~/.code-agent/.env 的 ZHIPU_CODING_API_KEY。
//
// Run:
//   npx tsx scripts/acceptance/role-proactivity-chat-tune-real.ts
// ============================================================================

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { setRoleProactivitySchema } from '../../src/host/tools/modules/roleAuthoring/setRoleProactivity.schema';
import { askUserQuestionSchema } from '../../src/host/tools/modules/planning/askUserQuestion.schema';

const KEY_ENV = 'ZHIPU_CODING_API_KEY';
const BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODEL = 'glm-5.3';
const MAX_TOKENS = 4096; // glm-5.3 是推理模型，小预算会被 reasoning 烧光（content 空 + finish_reason=length）
const TEMPERATURE = 0;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_TURNS = 6;
const RUNS_PER_CASE = 3;

const PROMPT_A = '以后每天只跟我说一次，别报天气';
const PROMPT_B = '少烦我';

const SYSTEM_PROMPT = [
  '你是 Agent Neo 里帮用户管理「专家角色」的助手，当前会话是角色「研究员」的专属会话。',
  '研究员这类角色会按主动性设置定时醒来给用户推送简报/进展。',
  '调整主动性必须通过 set_role_proactivity 工具完成；改动会先弹确认卡给用户确认。',
].join('\n');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

class AcceptanceFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceFatalError';
  }
}

function fatal(message: string): never {
  throw new AcceptanceFatalError(message);
}

function loadCodingKey(): string {
  // harness 可能拦 Bash 直接读 env 文件；脚本自己用 fs 读，key 不落 shell 历史
  const envPath = path.join(homedir(), '.code-agent', '.env');
  let raw = '';
  try {
    raw = readFileSync(envPath, 'utf-8');
  } catch {
    fatal(`${KEY_ENV} is unset and ${envPath} is unreadable`);
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep < 0) continue;
    if (trimmed.slice(0, sep).trim() !== KEY_ENV) continue;
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) break;
    return value;
  }
  fatal(`${KEY_ENV} not found in ${envPath}`);
}

function clearInheritedProxy(): void {
  // open.bigmodel.cn 国内直连；继承的本地代理会把请求拐去海外出口
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[name];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ---- 工具面：真实 schema 直出（description/inputSchema 一字不改） ----
function toolsPayload(withAsk: boolean): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  const tools = [{ schema: setRoleProactivitySchema }, ...(withAsk ? [{ schema: askUserQuestionSchema }] : [])];
  return tools.map(({ schema }) => ({
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
    },
  }));
}

// ---- stub 审批：复刻真实工具在「用户点允许」后的输出 ----
function stubApprovalOutput(args: Record<string, unknown>): string {
  if (args.level === 'silent') {
    return '已按用户确认更新「研究员」的主动性：\n打扰频率：每日简报 -> 静默（不主动）\n请用一句话向用户确认改动已生效。';
  }
  const parts: string[] = [];
  if (args.once_a_day === true) parts.push('打扰频率：实时介入 -> 每日简报（每天 09:00）');
  if (Array.isArray(args.add_exclude) && args.add_exclude.length > 0) parts.push(`永远别提：+ ${(args.add_exclude as string[]).join('、')}`);
  return `已按用户确认更新「研究员」的主动性：\n${parts.join('\n') || '（无字段变化）'}\n请用一句话向用户确认改动已生效。`;
}

interface TurnRecord {
  role: string;
  content: string | null;
  toolCalls?: Array<{ name: string; arguments: string }>;
  toolCallId?: string;
}

interface CaseRun {
  caseName: 'A' | 'B';
  runIndex: number;
  prompt: string;
  turns: TurnRecord[];
  setProactivityCalls: Array<Record<string, unknown>>;
  askQuestionCalls: Array<Record<string, unknown>>;
  finalText: string;
  error?: string;
}

function hasQuestion(run: CaseRun): boolean {
  if (run.askQuestionCalls.length > 0) return true;
  return run.finalText.includes('？') || run.finalText.includes('?');
}

function scoreRun(run: CaseRun): { pass: boolean; reason: string } {
  const silentCalls = run.setProactivityCalls.filter((call) => call.level === 'silent');
  if (run.caseName === 'A') {
    const good = run.setProactivityCalls.find(
      (call) => call.once_a_day === true
        && Array.isArray(call.add_exclude)
        && (call.add_exclude as string[]).some((topic) => topic.includes('天气')),
    );
    if (silentCalls.length > 0) return { pass: false, reason: `误映射 silent：${JSON.stringify(silentCalls)}` };
    if (!good) return { pass: false, reason: `没有 once_a_day+add_exclude 天气 的调用，实际调用：${JSON.stringify(run.setProactivityCalls)}` };
    return { pass: true, reason: `命中 ${JSON.stringify(good)}` };
  }
  // B：不出现 silent 调用，且给出澄清式提问
  if (silentCalls.length > 0) return { pass: false, reason: `模糊诉求被映射成 silent：${JSON.stringify(silentCalls)}` };
  if (run.setProactivityCalls.length > 0) {
    return { pass: false, reason: `模糊诉求未经澄清就动手改设置：${JSON.stringify(run.setProactivityCalls)}` };
  }
  if (!hasQuestion(run)) return { pass: false, reason: '没有澄清式提问（无 ask_user_question 调用、正文也无问句）' };
  return { pass: true, reason: '未改设置且提出澄清问题' };
}

async function chatCompletion(apiKey: string, messages: ChatMessage[], withAsk: boolean): Promise<ChatMessage & { tool_calls?: ChatToolCall[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: toolsPayload(withAsk),
        tool_choice: 'auto',
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String(error);
    fatal(`network error calling ${BASE_URL}/chat/completions: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fatal(`non-JSON body with http-${response.status}`);
  }
  if (!response.ok) {
    const record = asRecord(body);
    const errText = JSON.stringify(record?.error ?? body)?.slice(0, 300);
    fatal(`http-${response.status} from ${BASE_URL}/chat/completions: ${errText}`);
  }
  const record = asRecord(body);
  const choices = record?.choices;
  if (!Array.isArray(choices) || choices.length === 0) fatal('bad shape: choices missing or empty');
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  if (!message) fatal('bad shape: choices[0].message missing');
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : null,
    tool_calls: message.tool_calls as ChatToolCall[] | undefined,
  };
}

async function runCase(apiKey: string, caseName: 'A' | 'B', prompt: string, runIndex: number): Promise<CaseRun> {
  const withAsk = caseName === 'B';
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  const run: CaseRun = {
    caseName,
    runIndex,
    prompt,
    turns: [{ role: 'user', content: prompt }],
    setProactivityCalls: [],
    askQuestionCalls: [],
    finalText: '',
  };
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const assistant = await chatCompletion(apiKey, messages, withAsk);
    run.turns.push({ role: 'assistant', content: assistant.content, toolCalls: assistant.tool_calls?.map((call) => ({ name: call.function.name, arguments: call.function.arguments })) });
    messages.push({ role: 'assistant', content: assistant.content, tool_calls: assistant.tool_calls });
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      run.finalText = assistant.content ?? '';
      return run;
    }
    for (const call of assistant.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = { __unparsable: call.function.arguments };
      }
      if (call.function.name === setRoleProactivitySchema.name) {
        run.setProactivityCalls.push(args);
        const toolResult = stubApprovalOutput(args);
        run.turns.push({ role: 'tool', content: toolResult, toolCallId: call.id });
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
      } else if (call.function.name === askUserQuestionSchema.name) {
        run.askQuestionCalls.push(args);
        const toolResult = '（用户本轮未作答；请先等用户选择，本轮不要再改任何设置）';
        run.turns.push({ role: 'tool', content: toolResult, toolCallId: call.id });
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
      } else {
        const toolResult = `unknown tool ${call.function.name}`;
        run.turns.push({ role: 'tool', content: toolResult, toolCallId: call.id });
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
      }
    }
  }
  run.finalText = '（轮次耗尽，未给出无工具调用的收尾回复）';
  return run;
}

function renderTranscript(run: CaseRun): string {
  const lines = [`## case ${run.caseName} run ${run.runIndex} — "${run.prompt}"`];
  for (const turn of run.turns) {
    if (turn.role === 'user') lines.push(`**user**: ${turn.content}`);
    else if (turn.role === 'assistant') {
      lines.push(`**assistant**: ${turn.content ?? ''}`);
      for (const call of turn.toolCalls ?? []) lines.push(`**assistant tool_call**: ${call.name}(${call.arguments})`);
    } else if (turn.role === 'tool') {
      lines.push(`**tool(${turn.toolCallId})**: ${turn.content}`);
    }
  }
  return lines.join('\n\n');
}

async function main(): Promise<void> {
  const apiKey = process.env[KEY_ENV]?.trim() || loadCodingKey();
  clearInheritedProxy();

  const outDir = process.env.PROACTIVITY_TUNE_OUT_DIR
    ?? path.join(homedir(), 'work', 'out', 'N-ROLE-PROACTIVITY-CHAT-TUNE');
  mkdirSync(outDir, { recursive: true });

  // 便宜探针：key/端点/模型任一不通都在烧完 6 轮之前红出来
  {
    const probe = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }),
    });
    if (probe.status === 401 || probe.status === 403) fatal(`probe http-${probe.status}: key rejected`);
    if (!probe.ok) fatal(`probe http-${probe.status}: ${JSON.stringify(await probe.text()).slice(0, 200)}`);
    console.log(`[probe] http-${probe.status} ok`);
  }

  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
  const runs: CaseRun[] = [];
  for (let i = 1; i <= RUNS_PER_CASE; i += 1) {
    runs.push(await runCase(apiKey, 'A', PROMPT_A, i));
  }
  for (let i = 1; i <= RUNS_PER_CASE; i += 1) {
    runs.push(await runCase(apiKey, 'B', PROMPT_B, i));
  }

  const report: string[] = [
    `# N-ROLE-PROACTIVITY-CHAT-TUNE 真模型验收（${MODEL} @ coding 端点）`,
    ``,
    `HEAD ${gitHead}；温度 ${TEMPERATURE}；每案 ${RUNS_PER_CASE} 轮；工具面 = 真实 schema（set_role_proactivity${' + AskUserQuestion（B 案）'}）+ stub 审批。`,
    ``,
  ];
  let passA = 0;
  let passB = 0;
  for (const run of runs) {
    const { pass, reason } = scoreRun(run);
    if (pass && run.caseName === 'A') passA += 1;
    if (pass && run.caseName === 'B') passB += 1;
    report.push(`- case ${run.caseName} run ${run.runIndex}: ${pass ? 'PASS' : 'FAIL'} — ${reason}`);
  }
  report.push('', `## 汇总：A（每天一次+别报天气）${passA}/${RUNS_PER_CASE} 通过；B（少烦我 → 澄清而非 silent）${passB}/${RUNS_PER_CASE} 通过`, '');
  for (const run of runs) {
    report.push(renderTranscript(run), '');
  }
  const reportText = report.join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(outDir, `real-model-${stamp}.md`);
  writeFileSync(reportPath, reportText, 'utf-8');
  writeFileSync(path.join(tmpdir(), `proactivity-tune-last-report-path.txt`), reportPath, 'utf-8');

  console.log(reportText);
  console.log(`\n[report written] ${reportPath}`);
  process.exitCode = passA === RUNS_PER_CASE && passB === RUNS_PER_CASE ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 2;
});
