#!/usr/bin/env npx tsx
// A/B runner: does the "only when the user explicitly names a workflow" description
// reduce unprompted workflow opens on GLM? (N-WORKFLOW-BACKGROUND-AB-GLM)
//
// Two arms over the same fixture, one chat-completions request per question each:
//   before = description extracted from `git show 999ccc4ef^:src/host/tools/modules/multiagent/workflow.schema.ts`
//            (pre-PR-#2243 wording)
//   after  = the same literal extracted from the working-tree file (post-#2243 wording)
// The ONLY difference between arms is that description — same system prompt (fixture
// file, shared), same stub tools (Read/WebSearch/Bash), same temperature 0.
//
// File-local constants by design: this endpoint/model/key-env belong to the ZHIPU
// coding subscription and are deliberately NOT registered providers in src/shared
// (do not wire them there, do not fall back to MODEL_API_ENDPOINTS.zhipuCoding,
// never use a pay-per-token key). Keys stay in the environment; this script prints
// set/unset only.
//
// Fail-loud: key unset / auth error / model unavailable / unexpected response shape /
// extraction failure → exit non-zero and write NO result file. result.json is written
// only after every request in both arms succeeded.
//
// Modes:
//   (no args)      real run, writes docs/research/assets/2026-10-06-workflow-ab-glm/result.json
//   --self-check   offline sanity of extraction/stub/scoring helpers, no network
//   --stub-http <auth|model-not-found|bad-shape>
//                  offline exit-path rehearsal: replaces fetch with one canned failing
//                  response, skips the key check, never writes result.json

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AbAuthError,
  AbBadShapeError,
  AbModelNotFoundError,
  AbNetworkError,
  aggregateRates,
  extractToolCallNames,
  extractUsage,
  postChatCompletion,
  requireCodingApiKey,
  scoreQuestion,
  validateQuestions,
  type AbGroup,
  type AbQuestion,
  type AbUsage,
  type FetchLike,
} from './workflow-background-ab-scorer';

const ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const MODEL = 'glm-5.3';
const API_KEY_ENV = 'ZHIPU_CODING_API_KEY';
const TEMPERATURE = 0;
const MAX_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 120_000;
const INTER_REQUEST_MS = 300;
const PARENT_COMMIT = '999ccc4ef';
const SCHEMA_PATH = 'src/host/tools/modules/multiagent/workflow.schema.ts';
const DESCRIPTION_MARKER = 'const description = `';
const DESCRIPTION_HEAD = 'Author and run a JS orchestration script';
const OUT_PATH = 'docs/research/assets/2026-10-06-workflow-ab-glm/result.json';
const STUB_MODES = ['auth', 'model-not-found', 'bad-shape'] as const;
type StubMode = (typeof STUB_MODES)[number];

interface ArmRow {
  id: string;
  group: AbGroup;
  toolCalls: string[];
  opened: boolean;
  pass: boolean;
  ms: number;
  promptTokens: number;
  completionTokens: number;
}

interface ArmResult {
  arm: 'before' | 'after';
  perQuestion: ArmRow[];
  named: { total: number; opened: number; hitRate: number };
  unnamed: { total: number; opened: number; falseOpenRate: number };
  usage: AbUsage;
}

// Fixed small stub tools so the model has realistic alternatives to `workflow`.
const STUB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from disk and return its contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of the file to read.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: 'Search the web and return the top results.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command and return its stdout and stderr.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run.' } },
        required: ['command'],
      },
    },
  },
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(scriptDir, 'fixtures');

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`repo root not found above ${start}`);
    dir = parent;
  }
}

function keyState(envName: string): 'set' | 'unset' {
  const value = process.env[envName];
  return value !== undefined && value.trim().length > 0 ? 'set' : 'unset';
}

function clearInheritedProxy(): void {
  // The endpoint is domestic; any inherited proxy env would hijack the request.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[name];
  }
}

function readFlagValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

/**
 * Extract the `const description = \`...\`` template literal from a workflow.schema.ts
 * source and unescape it (`\`` → `` ` ``, `\$` → `$`, generally `\X` → `X`). The real
 * literal contains real newlines and escaped backticks only; the `\n`/`\t`/`\r`
 * two-char sequences are rejected so the generic unescape cannot silently change
 * meaning. Missing marker, unterminated literal, or an empty result is fatal.
 */
function extractDescriptionLiteral(source: string, sourceLabel: string): string {
  const start = source.indexOf(DESCRIPTION_MARKER);
  if (start < 0) throw new Error(`description literal not found in ${sourceLabel}`);
  let index = start + DESCRIPTION_MARKER.length;
  let raw = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next === undefined) throw new Error(`description literal ends on a dangling escape in ${sourceLabel}`);
      if (next === 'n' || next === 't' || next === 'r') {
        throw new Error(`description literal contains a \\${next} escape in ${sourceLabel}; unescape rule only covers backtick and dollar`);
      }
      raw += next;
      index += 2;
      continue;
    }
    if (char === '`') {
      if (raw.trim().length === 0) throw new Error(`description literal is empty in ${sourceLabel}`);
      return raw;
    }
    raw += char;
    index += 1;
  }
  throw new Error(`description literal unterminated in ${sourceLabel}`);
}

function validateDescription(description: string, arm: 'before' | 'after', sourceLabel: string): string {
  if (description.trim().length < 200) {
    throw new Error(`${arm} description from ${sourceLabel} is suspiciously short (${description.length} chars)`);
  }
  if (!description.includes(DESCRIPTION_HEAD)) {
    throw new Error(`${arm} description from ${sourceLabel} does not start with the known lead line`);
  }
  return description;
}

/** Property keys + required list of `workflowInputSchema` in the working-tree source. */
function extractInputSchemaShape(source: string): { properties: string[]; required: string[] } {
  const marker = 'const workflowInputSchema = {';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('workflowInputSchema not found in source');
  const end = source.indexOf('\n};', start);
  if (end < 0) throw new Error('workflowInputSchema block unterminated');
  const block = source.slice(start, end);
  const properties: string[] = [];
  for (const match of block.matchAll(/^ {4}([A-Za-z]+): \{$/gm)) {
    properties.push(match[1]);
  }
  const requiredMatch = block.match(/required: \[([^\]]*)\]/);
  if (properties.length === 0 || !requiredMatch) {
    throw new Error('workflowInputSchema properties/required could not be parsed from source');
  }
  const required = requiredMatch[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
  return { properties, required };
}

function checkInputSchemaFixture(fixture: unknown): Record<string, unknown> {
  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
    throw new Error('workflow input-schema fixture is not a JSON object');
  }
  const properties = (fixture as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error('workflow input-schema fixture has no properties object');
  }
  const source = fs.readFileSync(path.join(findRepoRoot(scriptDir), SCHEMA_PATH), 'utf8');
  const shape = extractInputSchemaShape(source);
  const fixtureKeys = Object.keys(properties);
  if (fixtureKeys.join(',') !== shape.properties.join(',') || fixtureKeys.length !== shape.properties.length) {
    throw new Error(`input-schema fixture keys [${fixtureKeys.join(',')}] drifted from source [${shape.properties.join(',')}]`);
  }
  const fixtureRequired = (fixture as { required?: unknown }).required;
  if (!Array.isArray(fixtureRequired) || fixtureRequired.join(',') !== shape.required.join(',')) {
    throw new Error(`input-schema fixture required [${JSON.stringify(fixtureRequired)}] drifted from source [${shape.required.join(',')}]`);
  }
  return fixture as Record<string, unknown>;
}

function makeFailingStubFetch(mode: StubMode): FetchLike {
  const canned: Record<StubMode, { status: number; body: string }> = {
    auth: { status: 401, body: JSON.stringify({ error: { code: '1001', message: 'invalid api key' } }) },
    'model-not-found': { status: 404, body: JSON.stringify({ error: { code: '1211', message: 'model not found: glm-5.3' } }) },
    'bad-shape': { status: 200, body: JSON.stringify({ id: 'resp_stub', object: 'chat.completion', choices: [] }) },
  };
  const entry = canned[mode];
  return async () => new Response(entry.body, { status: entry.status, headers: { 'Content-Type': 'application/json' } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function askOnce(params: {
  apiKey: string;
  systemPrompt: string;
  question: AbQuestion;
  workflowDescription: string;
  inputSchema: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<{ toolCalls: string[]; usage: AbUsage }> {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.question.prompt },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'workflow',
          description: params.workflowDescription,
          parameters: params.inputSchema,
        },
      },
      ...STUB_TOOLS,
    ],
    tool_choice: 'auto',
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
  };
  const response = await postChatCompletion({
    endpoint: ENDPOINT,
    apiKey: params.apiKey,
    body,
    fetchImpl: params.fetchImpl,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { toolCalls: extractToolCallNames(response), usage: extractUsage(response) };
}

async function runArm(params: {
  arm: 'before' | 'after';
  apiKey: string;
  systemPrompt: string;
  questions: AbQuestion[];
  workflowDescription: string;
  inputSchema: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<ArmResult> {
  const rows: ArmRow[] = [];
  const usage: AbUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const question of params.questions) {
    const startedAt = Date.now();
    const answer = await askOnce({
      apiKey: params.apiKey,
      systemPrompt: params.systemPrompt,
      question,
      workflowDescription: params.workflowDescription,
      inputSchema: params.inputSchema,
      fetchImpl: params.fetchImpl,
    });
    const verdict = scoreQuestion(question.group, answer.toolCalls);
    const row: ArmRow = {
      id: question.id,
      group: question.group,
      toolCalls: answer.toolCalls,
      opened: verdict.opened,
      pass: verdict.pass,
      ms: Date.now() - startedAt,
      promptTokens: answer.usage.promptTokens,
      completionTokens: answer.usage.completionTokens,
    };
    rows.push(row);
    usage.promptTokens += answer.usage.promptTokens;
    usage.completionTokens += answer.usage.completionTokens;
    usage.totalTokens += answer.usage.totalTokens;
    console.log(
      `${params.arm} ${row.id} group=${row.group} opened=${row.opened} pass=${row.pass} toolCalls=${row.toolCalls.join(',') || '-'} ms=${row.ms} in=${row.promptTokens} out=${row.completionTokens}`,
    );
    await sleep(INTER_REQUEST_MS);
  }
  const rates = aggregateRates(rows);
  console.log(
    `${params.arm} rates named=${rates.named.opened}/${rates.named.total} hitRate=${rates.named.hitRate.toFixed(4)} unnamedOpened=${rates.unnamed.opened}/${rates.unnamed.total} falseOpenRate=${rates.unnamed.falseOpenRate.toFixed(4)}`,
  );
  return { arm: params.arm, perQuestion: rows, named: rates.named, unnamed: rates.unnamed, usage };
}

function assertNoSecretMarkers(json: string, apiKey: string): void {
  // Guard the secret VALUE (and any Authorization echo), not the env-var NAME —
  // the name is public metadata, matching on it rejects the report itself.
  const markers = ['Bearer ', apiKey];
  if (markers.some((marker) => json.includes(marker))) {
    throw new Error('refusing to write JSON that mentions a key field');
  }
}

function selfCheck(): void {
  // Synthetic schema source: escaped backtick and escaped dollar inside the literal,
  // plus a real newline — the only escape forms the real description uses.
  const backtick = '`';
  const backslash = '\\';
  const syntheticSource = `const description = ${backtick}Head ${backslash}${backtick}code${backslash}$ here\nsecond line${backtick};`;
  const extracted = extractDescriptionLiteral(syntheticSource, 'self-check');
  const expected = `Head ${backtick}code$ here\nsecond line`;
  if (extracted !== expected) throw new Error(`unescape drifted: ${JSON.stringify(extracted)}`);

  let rejected = false;
  try {
    extractDescriptionLiteral(`const description = ${backtick}a${backslash}n b${backtick};`, 'self-check');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('backslash-n escape must be rejected by the unescape rule');

  let unterminated = false;
  try {
    extractDescriptionLiteral(`const description = ${backtick}no end`, 'self-check');
  } catch {
    unterminated = true;
  }
  if (!unterminated) throw new Error('unterminated literal must throw');

  const shape = extractInputSchemaShape(
    "const workflowInputSchema = {\n  type: 'object' as const,\n  properties: {\n    script: {\n      type: 'string',\n    },\n    goal: {\n      type: 'string',\n    },\n  },\n  required: ['script'] as string[],\n};",
  );
  if (shape.properties.join(',') !== 'script,goal' || shape.required.join(',') !== 'script') {
    throw new Error(`input schema shape parse drifted: ${JSON.stringify(shape)}`);
  }

  const verdict = scoreQuestion('named', ['Read', 'workflow']);
  if (!verdict.opened || !verdict.pass) throw new Error('self-check scoring drifted');
  console.log('self-check ok');
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    return;
  }

  const stubMode = readFlagValue('--stub-http');
  if (stubMode !== undefined && !STUB_MODES.includes(stubMode as StubMode)) {
    throw new Error(`--stub-http must be one of ${STUB_MODES.join('|')}, got: ${stubMode}`);
  }

  console.log(`${API_KEY_ENV}=${keyState(API_KEY_ENV)}`);
  clearInheritedProxy();
  console.log('inherited-proxy=cleared');

  const repoRoot = findRepoRoot(scriptDir);

  // Fixtures.
  const questionsRaw = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'workflow-background-ab-questions.json'), 'utf8')) as unknown;
  const questions = validateQuestions(questionsRaw);
  const systemPrompt = fs.readFileSync(path.join(fixturesDir, 'workflow-background-ab-system-prompt.txt'), 'utf8').trim();
  if (systemPrompt.length === 0 || /workflow|工作流/i.test(systemPrompt)) {
    throw new Error('system prompt fixture must be non-empty and must not mention workflow (neutrality)');
  }
  const inputSchema = checkInputSchemaFixture(
    JSON.parse(fs.readFileSync(path.join(fixturesDir, 'workflow-background-ab-workflow-input-schema.json'), 'utf8')) as unknown,
  );

  // Arm descriptions: before from the parent of the A/B commit, after from the working tree.
  const afterSource = fs.readFileSync(path.join(repoRoot, SCHEMA_PATH), 'utf8');
  const afterDescription = validateDescription(
    extractDescriptionLiteral(afterSource, `working tree ${SCHEMA_PATH}`),
    'after',
    `working tree ${SCHEMA_PATH}`,
  );
  let beforeSource: string;
  try {
    beforeSource = execFileSync('git', ['show', `${PARENT_COMMIT}^:${SCHEMA_PATH}`], { cwd: repoRoot, encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      `git show ${PARENT_COMMIT}^:${SCHEMA_PATH} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const beforeDescription = validateDescription(
    extractDescriptionLiteral(beforeSource, `git ${PARENT_COMMIT}^`),
    'before',
    `git ${PARENT_COMMIT}^`,
  );
  if (beforeDescription === afterDescription) {
    throw new Error('before/after descriptions are identical — the A/B premise does not hold at this commit');
  }
  console.log(`descriptions before=${beforeDescription.length} chars, after=${afterDescription.length} chars (differ: yes)`);

  // Key: real mode fails loud here; stub mode is an offline rehearsal and needs no key.
  const apiKey = stubMode === undefined
    ? requireCodingApiKey(process.env, API_KEY_ENV)
    : 'stub-mode-no-key';
  const fetchImpl = stubMode === undefined ? undefined : makeFailingStubFetch(stubMode as StubMode);
  if (stubMode !== undefined) console.log(`stub-http=${stubMode} (offline rehearsal, never writes result.json)`);

  const namedCount = questions.filter((question) => question.group === 'named').length;
  const unnamedCount = questions.length - namedCount;
  console.log(`questions named=${namedCount} unnamed=${unnamedCount} model=${MODEL} temperature=${TEMPERATURE}`);

  const startedAt = Date.now();
  const before = await runArm({
    arm: 'before',
    apiKey,
    systemPrompt,
    questions,
    workflowDescription: beforeDescription,
    inputSchema,
    fetchImpl,
  });
  const after = await runArm({
    arm: 'after',
    apiKey,
    systemPrompt,
    questions,
    workflowDescription: afterDescription,
    inputSchema,
    fetchImpl,
  });
  const wallTimeMs = Date.now() - startedAt;

  // Everything succeeded — only now is the result file written.
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const report = {
    generatedAt: new Date().toISOString(),
    gitHead,
    model: MODEL,
    endpoint: ENDPOINT,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    questionCounts: { named: namedCount, unnamed: unnamedCount, total: questions.length },
    descriptionSources: {
      before: `git show ${PARENT_COMMIT}^:${SCHEMA_PATH}`,
      after: `working tree ${SCHEMA_PATH}`,
    },
    descriptionExcerpt: {
      before: beforeDescription.slice(0, 160),
      after: afterDescription.slice(0, 160),
    },
    arms: { before, after },
    wallTimeMs,
    tokenUsage: {
      promptTokens: before.usage.promptTokens + after.usage.promptTokens,
      completionTokens: before.usage.completionTokens + after.usage.completionTokens,
      totalTokens: before.usage.totalTokens + after.usage.totalTokens,
    },
    scopeNote: 'Conclusion holds for GLM on the ZHIPU coding subscription endpoint only (single run, temperature 0).',
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  assertNoSecretMarkers(json, apiKey);
  const outPath = path.join(repoRoot, OUT_PATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, outPath);

  console.log(`\nsummary before: unnamedFalseOpenRate=${before.unnamed.falseOpenRate.toFixed(4)} namedHitRate=${before.named.hitRate.toFixed(4)}`);
  console.log(`summary after:  unnamedFalseOpenRate=${after.unnamed.falseOpenRate.toFixed(4)} namedHitRate=${after.named.hitRate.toFixed(4)}`);
  console.log(`wallTimeMs=${wallTimeMs} tokens=${JSON.stringify(report.tokenUsage)}`);
  console.log(`json=${outPath}`);
}

// 同 N-EVAL-CI-NOEXIT：真跑里 fetch/keep-alive 等常驻句柄让事件循环排不空。
// 活干完就退；先排空 stdout 再退，避免管道场景截断汇总。失败路径语义不动：非零 exit 仍在。
main().then(() => {
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}).catch((error: unknown) => {
  if (error instanceof AbAuthError) {
    console.error(`fail-loud auth: ${error.message}; no result file`);
  } else if (error instanceof AbModelNotFoundError) {
    console.error(`fail-loud model: ${error.message}; no result file`);
  } else if (error instanceof AbBadShapeError) {
    console.error(`fail-loud shape: ${error.message}; no result file`);
  } else if (error instanceof AbNetworkError) {
    console.error(`fail-loud network: ${error.message}; no result file`);
  } else {
    console.error(`fail-loud: ${error instanceof Error ? error.message : String(error)}; no result file`);
  }
  process.exit(1);
});
