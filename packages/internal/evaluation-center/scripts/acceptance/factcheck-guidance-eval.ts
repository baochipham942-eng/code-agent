#!/usr/bin/env npx tsx
// Fact-check guidance replay eval (N-ARTIFACT-FACTCHECK-EVAL-GLM).
//
// Replays 6 artifact-generation scenarios against the GLM coding-plan
// chat/completions endpoint with ARTIFACT_TASK_BRIEF_PROMPT as the system
// text and stubbed Read/Write/WebSearch tools, then scores each transcript
// with the pure scorer in factcheckGuidanceScorer.ts. Writes
// docs/research/assets/2026-10-06-factcheck-eval/baseline.json plus an
// evidence note beside it, atomically (tmp file + rename).
//
// This script owns its own constants (the repo catalogue has no glm-5.3 and
// the zhipuCoding proxy entry is explicitly NOT used here):
//   endpoint  https://open.bigmodel.cn/api/coding/paas/v4  (domestic, direct —
//             inherited HTTP(S)_PROXY is cleared, the app env file may set one)
//   key env   ZHIPU_CODING_API_KEY  — stays in the environment, only
//             set/unset is printed. Machine usage:
//               set -a; source ~/.code-agent/.env; set +a; npm run eval:factcheck-guidance
//   model     glm-5.3, overridable via FACTCHECK_EVAL_MODEL.
//   FACTCHECK_EVAL_BASE_URL exists only so the fail-loud paths (model
//   unavailable / bad shape) can be demonstrated against a local mock with a
//   dummy key and zero spend.
//
// Fail-loud, no JSON is written when: the key is unset, the model is
// unavailable (HTTP 404 / model-not-found), a required scenario is missing
// from the fixture, or any response has a bad shape.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTIFACT_TASK_BRIEF_PROMPT } from '@host/prompts/artifactGeneration';

import {
  parseFactCheckFixture,
  scoreFactCheckScenario,
  toolPathMatches,
  type FactCheckFixture,
  type FactCheckScenario,
  type FactCheckToolCall,
} from './factcheckGuidanceScorer';

const KEY_ENV = 'ZHIPU_CODING_API_KEY';
const ZHIPU_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const FACTCHECK_EVAL_MODEL_DEFAULT = 'glm-5.3';
const MAX_TURNS = 8;
const MAX_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 90_000;
const TEMPERATURE = 0;
const FACT_CHECK_HEADING = 'Fact-check rules:';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const defaultFixturePath = path.join(
  repoRoot,
  'packages/internal/evaluation-center/scripts/acceptance/fixtures/factcheck-guidance-scenarios.json',
);
const outDir = path.join(repoRoot, 'docs/research/assets/2026-10-06-factcheck-eval');
const outJsonPath = path.join(outDir, 'baseline.json');
const outNotesPath = path.join(outDir, 'baseline-notes.md');

interface ReplayToolSchema {
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// Compact stand-ins for the real registered tools (src/host/tools/modules/
// file/read.schema.ts, write.schema.ts, network/webSearch.schema.ts). The
// judging only looks at tool-call order and args, so descriptions stay short.
const REPLAY_TOOL_SCHEMAS: Record<string, ReplayToolSchema> = {
  Read: {
    description: 'Read text from a local file in the working directory. Requires file_path.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the file to read.' },
        offset: { type: 'number', description: 'First line to read, 1-indexed.' },
        limit: { type: 'number', description: 'Line count to read.' },
      },
      required: ['file_path'],
    },
  },
  Write: {
    description: 'Write a file, creating parent directories. Overwrites existing files. Requires file_path and the complete content.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the file to write.' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['file_path', 'content'],
    },
  },
  WebSearch: {
    description: 'Search the web and return results with titles, URLs, and snippets. Requires a non-empty query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
};

interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

interface ChatCompletion {
  message: { content: string | null; tool_calls?: ChatToolCall[] };
  usage: ChatUsage;
}

interface ScenarioRun {
  scenario: FactCheckScenario;
  pass: boolean;
  details: string;
  turnsUsed: number;
  exhaustedTurns: boolean;
  toolCallNames: string[];
  toolCallSummaries: string[];
  finalTextExcerpt: string;
  promptTokens: number;
  completionTokens: number;
  wallMs: number;
}

class EvalFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFatalError';
  }
}

function fatal(message: string): never {
  throw new EvalFatalError(message);
}

function keyState(name: string): 'set' | 'unset' {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0 ? 'set' : 'unset';
}

function clearInheritedProxy(): void {
  // The app env file may export a local proxy for international endpoints;
  // open.bigmodel.cn is domestic and must go direct (jev script, same trap).
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[name];
  }
}

function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function redact(message: string, secrets: string[]): string {
  let out = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 400);
}

function toolsPayload(scenario: FactCheckScenario): Array<{ type: 'function'; function: { name: string; description: string; parameters: ReplayToolSchema['parameters'] } }> {
  return scenario.tools.map((name) => {
    const schema = REPLAY_TOOL_SCHEMAS[name];
    if (!schema) fatal(`bad shape: no replay schema for tool ${name}`);
    return { type: 'function', function: { name, description: schema.description, parameters: schema.parameters } };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function modelUnavailable(status: number, errorBody: unknown): boolean {
  if (status === 404) return true;
  const record = asRecord(errorBody);
  const error = record ? asRecord(record.error) : null;
  const message = error && typeof error.message === 'string' ? error.message : '';
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /model.*(not.*(found|exist)| unavailable|不存在)/i.test(message)
    || /模型不存在|不存在的模型/.test(message)
    || /^(1211|1214|10007)$/.test(code);
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  scenario: FactCheckScenario,
): Promise<ChatCompletion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: toolsPayload(scenario),
        tool_choice: 'auto',
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String(error);
    fatal(`network error calling ${baseUrl}/chat/completions: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fatal(`bad shape: non-JSON body with http-${response.status}`);
  }
  if (!response.ok) {
    if (modelUnavailable(response.status, body)) {
      fatal(`model unavailable (http-${response.status}, model=${model})`);
    }
    fatal(`http-${response.status} from ${baseUrl}/chat/completions`);
  }
  const record = asRecord(body);
  if (!record) fatal('bad shape: response body is not an object');
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    fatal('bad shape: choices missing or empty');
  }
  const first = asRecord(choices[0]);
  if (!first) fatal('bad shape: choices[0] is not an object');
  const message = asRecord(first.message);
  if (!message) fatal('bad shape: choices[0].message missing');
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls)) fatal('bad shape: message.tool_calls is not an array');
    for (const call of toolCalls) {
      const entry = asRecord(call);
      const fn = entry ? asRecord(entry.function) : null;
      if (!entry || typeof entry.id !== 'string' || !fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
        fatal('bad shape: tool_calls entry missing id/function.name/function.arguments');
      }
    }
  }
  const usage = asRecord(record.usage);
  const promptTokens = usage ? usage.prompt_tokens : undefined;
  const completionTokens = usage ? usage.completion_tokens : undefined;
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)
    || typeof completionTokens !== 'number' || !Number.isFinite(completionTokens)) {
    fatal('bad shape: usage.prompt_tokens / usage.completion_tokens missing');
  }
  const content = message.content;
  if (toolCalls === undefined || toolCalls.length === 0) {
    if (typeof content !== 'string') {
      fatal('bad shape: final message content is not a string');
    }
  } else if (content !== null && content !== undefined && typeof content !== 'string') {
    fatal('bad shape: assistant content alongside tool_calls is not a string');
  }
  return {
    message: {
      content: typeof content === 'string' ? content : null,
      tool_calls: Array.isArray(toolCalls) ? (toolCalls as ChatToolCall[]) : undefined,
    },
    usage: { promptTokens, completionTokens },
  };
}

function stubToolResult(
  scenario: FactCheckScenario,
  name: string,
  args: Record<string, unknown>,
  writtenFiles: Map<string, string>,
): string {
  if (name === 'Read') {
    const target = typeof args.file_path === 'string' ? args.file_path : '';
    for (const [fixturePath, content] of Object.entries(scenario.reads)) {
      if (toolPathMatches(target, fixturePath)) return content;
    }
    for (const [writtenPath, content] of writtenFiles) {
      if (toolPathMatches(target, writtenPath)) return content;
    }
    return `ERROR: file not found: ${target || '(no file_path)'}`;
  }
  if (name === 'Write') {
    const target = typeof args.file_path === 'string' ? args.file_path : '(no file_path)';
    const content = typeof args.content === 'string' ? args.content : '';
    writtenFiles.set(target, content);
    return `Wrote ${target} (${Buffer.byteLength(content, 'utf8')} bytes)`;
  }
  if (name === 'WebSearch') {
    return scenario.webSearchResult ?? 'ERROR: WebSearch is not registered in this turn';
  }
  return `ERROR: tool ${name} is not registered in this turn`;
}

function toolCallSummary(name: string, args: Record<string, unknown>): string {
  if (name === 'Read' || name === 'Write') {
    const target = typeof args.file_path === 'string' ? args.file_path : '(no file_path)';
    return `${name}:${target}`;
  }
  if (name === 'WebSearch') {
    const query = typeof args.query === 'string' ? args.query.slice(0, 80) : '(no query)';
    return `WebSearch:${query}`;
  }
  return name;
}

async function runScenario(
  scenario: FactCheckScenario,
  systemPrompt: string,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<ScenarioRun> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scenario.userMessage },
  ];
  const toolCalls: FactCheckToolCall[] = [];
  const writtenFiles = new Map<string, string>();
  const toolCallSummaries: string[] = [];
  let finalText = '';
  let exhaustedTurns = false;
  let turnsUsed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const startedAt = Date.now();
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    turnsUsed = turn;
    const completion = await chatCompletion(baseUrl, apiKey, model, messages, scenario);
    promptTokens += completion.usage.promptTokens;
    completionTokens += completion.usage.completionTokens;
    const callList = completion.message.tool_calls ?? [];
    if (callList.length === 0) {
      finalText = completion.message.content ?? '';
      break;
    }
    messages.push({ role: 'assistant', content: completion.message.content ?? '', tool_calls: callList });
    for (const call of callList) {
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(call.function.arguments);
        args = asRecord(parsed) ?? {};
      } catch {
        fatal(`bad shape: tool ${call.function.name} arguments are not valid JSON`);
      }
      toolCalls.push({ name: call.function.name, args });
      toolCallSummaries.push(toolCallSummary(call.function.name, args));
      messages.push({ role: 'tool', tool_call_id: call.id, content: stubToolResult(scenario, call.function.name, args, writtenFiles) });
    }
    if (turn === MAX_TURNS) exhaustedTurns = true;
  }
  const judged = scoreFactCheckScenario({ toolCalls, finalText }, scenario);
  return {
    scenario,
    pass: judged.pass,
    details: judged.details,
    turnsUsed,
    exhaustedTurns,
    toolCallNames: toolCalls.map((call) => call.name),
    toolCallSummaries,
    finalTextExcerpt: finalText.slice(0, 240),
    promptTokens,
    completionTokens,
    wallMs: Date.now() - startedAt,
  };
}

function assertNoSecretMarkers(json: string, apiKey: string): void {
  if (json.includes('Bearer ') || (apiKey && json.includes(apiKey))) {
    fatal('refusing to write JSON that mentions a key');
  }
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function renderNotes(
  model: string,
  baseUrl: string,
  head: string,
  runs: ScenarioRun[],
  totals: { promptTokens: number; completionTokens: number; wallMs: number },
): string {
  const lines = [
    '# Fact-check guidance baseline (2026-10-06)',
    '',
    '- Ticket: N-ARTIFACT-FACTCHECK-EVAL-GLM.',
    '- Question: does the model obey the `Fact-check rules:` block of `ARTIFACT_TASK_BRIEF_PROMPT` when it generates artifacts?',
    `- Model \`${model}\` against \`${baseUrl}/chat/completions\` (subscription key from env \`ZHIPU_CODING_API_KEY\`, zero marginal spend).`,
    `- System text = \`ARTIFACT_TASK_BRIEF_PROMPT\` + the scenario system context; tools Read/Write/WebSearch replayed with stub results; turn cap ${MAX_TURNS}.`,
    `- gitHead \`${head}\`. Rerun: \`set -a; source ~/.code-agent/.env; set +a; npm run eval:factcheck-guidance\`.`,
    `- Elapsed ${totals.wallMs} ms, prompt tokens ${totals.promptTokens}, completion tokens ${totals.completionTokens}.`,
    '',
    '| scenario | rule | pass | details |',
    '|---|---|---|---|',
  ];
  for (const run of runs) {
    lines.push(`| ${run.scenario.id} | ${run.scenario.rule.kind} | ${run.pass ? 'PASS' : 'FAIL'} | ${run.details.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push('Caveats: deterministic keyword judging (gap phrases and citation markers live in the fixture); a model can evade the keyword lists, and rule (a)/(b) accept any qualifying lookup before the first Write without judging search quality.');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtureFlagIndex = args.indexOf('--fixture');
  const fixturePath = fixtureFlagIndex >= 0 && args[fixtureFlagIndex + 1]
    ? path.resolve(args[fixtureFlagIndex + 1])
    : defaultFixturePath;

  const baseUrl = (process.env.FACTCHECK_EVAL_BASE_URL ?? '').trim() || ZHIPU_CODING_BASE_URL;
  const model = (process.env.FACTCHECK_EVAL_MODEL ?? '').trim() || FACTCHECK_EVAL_MODEL_DEFAULT;

  clearInheritedProxy();
  console.log('inherited-proxy=cleared');
  console.log(`${KEY_ENV}=${keyState(KEY_ENV)}`);
  console.log(`model=${model} endpoint=${baseUrl}/chat/completions`);

  // 1. fixture must parse and contain every required scenario (fail-loud,
  //    before any key or network is touched).
  let fixture: FactCheckFixture;
  try {
    fixture = parseFactCheckFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as unknown);
  } catch (error) {
    fatal(`fixture ${fixturePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. the system text under test must actually carry the fact-check rules.
  const brief = String(ARTIFACT_TASK_BRIEF_PROMPT);
  if (!brief.includes(FACT_CHECK_HEADING)) {
    fatal(`system text under test has no "${FACT_CHECK_HEADING}" section (prompt override?)`);
  }

  // 3. key must come from the environment; never improvised.
  const apiKey = process.env[KEY_ENV]?.trim() ?? '';
  if (!apiKey) {
    fatal(`${KEY_ENV} unset`);
  }

  const head = gitHead();
  const systemPromptFor = (scenario: FactCheckScenario): string => `${brief}\n\n${scenario.systemContext}`;
  const runs: ScenarioRun[] = [];
  const startedAt = Date.now();
  for (const scenario of fixture.scenarios) {
    const run = await runScenario(scenario, systemPromptFor(scenario), model, apiKey, baseUrl);
    runs.push(run);
    console.log(
      `${run.scenario.id} pass=${run.pass} turns=${run.turnsUsed}${run.exhaustedTurns ? ' (exhausted)' : ''} calls=[${run.toolCallNames.join(',')}] in=${run.promptTokens} out=${run.completionTokens} ${run.wallMs}ms`,
    );
  }
  const wallMs = Date.now() - startedAt;
  const promptTokens = runs.reduce((sum, run) => sum + run.promptTokens, 0);
  const completionTokens = runs.reduce((sum, run) => sum + run.completionTokens, 0);
  const passed = runs.filter((run) => run.pass).length;

  const report = {
    generatedAt: new Date().toISOString(),
    gitHead: head,
    ticket: 'N-ARTIFACT-FACTCHECK-EVAL-GLM',
    model,
    endpoint: `${baseUrl}/chat/completions`,
    briefSha256: createHash('sha256').update(brief).digest('hex'),
    briefChars: brief.length,
    turnsCap: MAX_TURNS,
    maxTokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    totals: { scenarios: runs.length, passed, failed: runs.length - passed, wallMs, promptTokens, completionTokens },
    scenarios: runs.map((run) => ({
      id: run.scenario.id,
      probes: run.scenario.probes,
      ruleKind: run.scenario.rule.kind,
      pass: run.pass,
      details: run.details,
      turnsUsed: run.turnsUsed,
      exhaustedTurns: run.exhaustedTurns,
      toolCallNames: run.toolCallNames,
      toolCallSummaries: run.toolCallSummaries,
      finalTextExcerpt: run.finalTextExcerpt,
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      wallMs: run.wallMs,
    })),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  assertNoSecretMarkers(json, apiKey);
  writeAtomic(outJsonPath, json);
  writeAtomic(outNotesPath, renderNotes(model, baseUrl, head, runs, { promptTokens, completionTokens, wallMs }));
  console.log(`\npassed=${passed}/${runs.length} wallMs=${wallMs} in=${promptTokens} out=${completionTokens}`);
  console.log(`json=${outJsonPath}`);
  console.log(`notes=${outNotesPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof EvalFatalError
    ? error.message
    : `eval failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`factcheck-eval: ${redact(message, [process.env[KEY_ENV] ?? ''])}; no JSON`);
  process.exit(1);
});
