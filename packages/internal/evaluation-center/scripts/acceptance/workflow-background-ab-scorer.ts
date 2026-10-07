// Pure scorer for the workflow-tool-description A/B on GLM (N-WORKFLOW-BACKGROUND-AB-GLM).
// No IO in this module on purpose: shape mapping, scoring, aggregation, fixture
// semantics, and the endpoint failure taxonomy are all plain functions so the
// mock-replay unit test (tests/unit/evaluation/workflowBackgroundAbScorer.test.ts)
// can drive every fail-loud exit path with a stubbed fetch. The runner
// (workflow-background-ab-runner.ts) wires env, git, and the result file around it.

export type AbGroup = 'named' | 'unnamed';

export interface AbQuestion {
  id: string;
  group: AbGroup;
  prompt: string;
}

export interface AbQuestionVerdict {
  /** True iff the response contains a tool call named `workflow`. */
  opened: boolean;
  /** named → pass iff opened; unnamed → pass iff NOT opened. */
  pass: boolean;
}

export interface AbRates {
  named: { total: number; opened: number; hitRate: number };
  unnamed: { total: number; opened: number; falseOpenRate: number };
}

export interface AbUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const WORKFLOW_TOOL_NAME = 'workflow';
// A named question must literally name a workflow (either language); an unnamed
// question must not — this is the fixture's load-bearing semantic, validated here
// so a drifted fixture fails before any request is spent.
const NAMED_MARKER = /workflow|工作流/i;

export class AbAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbAuthError';
  }
}

export class AbModelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbModelNotFoundError';
  }
}

export class AbBadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbBadShapeError';
  }
}

export class AbNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbNetworkError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireCodingApiKey(env: Record<string, string | undefined>, envName: string): string {
  const value = env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw new AbAuthError(`${envName} is unset; refusing to run (no result file)`);
  }
  return value.trim();
}

/**
 * Mapping rule for the A/B: tool call names are read from
 * choices[0].message.tool_calls[].function.name. Anything else about the
 * response (content, reasoning, finish_reason) is ignored; a response that
 * does not match this shape is an error, not a zero.
 */
export function extractToolCallNames(response: unknown): string[] {
  if (!isRecord(response)) throw new AbBadShapeError('response is not an object');
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AbBadShapeError('response.choices missing or empty');
  }
  const first = choices[0];
  if (!isRecord(first)) throw new AbBadShapeError('choices[0] is not an object');
  const message = first.message;
  if (!isRecord(message)) throw new AbBadShapeError('choices[0].message is not an object');
  if (message.tool_calls === undefined) return [];
  if (!Array.isArray(message.tool_calls)) throw new AbBadShapeError('message.tool_calls is not an array');
  return message.tool_calls.map((call, index) => {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') {
      throw new AbBadShapeError(`tool_calls[${index}].function.name is not a string`);
    }
    return call.function.name;
  });
}

export function extractUsage(response: unknown): AbUsage {
  if (!isRecord(response)) throw new AbBadShapeError('response is not an object');
  const usage = response.usage;
  if (!isRecord(usage)) throw new AbBadShapeError('response.usage missing');
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
    throw new AbBadShapeError('usage.prompt_tokens / usage.completion_tokens are not numbers');
  }
  const totalRaw = usage.total_tokens;
  if (totalRaw !== undefined && typeof totalRaw !== 'number') {
    throw new AbBadShapeError('usage.total_tokens is not a number');
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: typeof totalRaw === 'number' ? totalRaw : promptTokens + completionTokens,
  };
}

export function scoreQuestion(group: AbGroup, toolCallNames: string[]): AbQuestionVerdict {
  const opened = toolCallNames.includes(WORKFLOW_TOOL_NAME);
  const pass = group === 'named' ? opened : !opened;
  return { opened, pass };
}

export function aggregateRates(rows: Array<{ group: AbGroup; opened: boolean }>): AbRates {
  const named = rows.filter((row) => row.group === 'named');
  const unnamed = rows.filter((row) => row.group === 'unnamed');
  const namedOpened = named.filter((row) => row.opened).length;
  const unnamedOpened = unnamed.filter((row) => row.opened).length;
  return {
    named: {
      total: named.length,
      opened: namedOpened,
      hitRate: named.length === 0 ? 0 : namedOpened / named.length,
    },
    unnamed: {
      total: unnamed.length,
      opened: unnamedOpened,
      falseOpenRate: unnamed.length === 0 ? 0 : unnamedOpened / unnamed.length,
    },
  };
}

export function validateQuestions(raw: unknown): AbQuestion[] {
  if (!isRecord(raw) || !Array.isArray(raw.questions)) {
    throw new AbBadShapeError('fixture: questions array missing');
  }
  const questions: AbQuestion[] = raw.questions.map((entry, index) => {
    if (!isRecord(entry)) throw new AbBadShapeError(`fixture question ${index} is not an object`);
    if (typeof entry.id !== 'string' || typeof entry.prompt !== 'string') {
      throw new AbBadShapeError(`fixture question ${index} missing id/prompt`);
    }
    if (entry.group !== 'named' && entry.group !== 'unnamed') {
      throw new AbBadShapeError(`fixture question ${entry.id}: group must be named|unnamed`);
    }
    return { id: entry.id, group: entry.group, prompt: entry.prompt };
  });
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length) throw new AbBadShapeError('fixture: duplicate ids');
  for (const question of questions) {
    if (question.prompt.trim().length === 0) {
      throw new AbBadShapeError(`fixture ${question.id}: empty prompt`);
    }
    const namesWorkflow = NAMED_MARKER.test(question.prompt);
    if (question.group === 'named' && !namesWorkflow) {
      throw new AbBadShapeError(`fixture ${question.id}: named prompt does not name a workflow`);
    }
    if (question.group === 'unnamed' && namesWorkflow) {
      throw new AbBadShapeError(`fixture ${question.id}: unnamed prompt mentions a workflow`);
    }
  }
  const namedCount = questions.filter((question) => question.group === 'named').length;
  const unnamedCount = questions.filter((question) => question.group === 'unnamed').length;
  if (namedCount < 6) throw new AbBadShapeError(`fixture: ${namedCount} named questions < 6`);
  if (unnamedCount < 6) throw new AbBadShapeError(`fixture: ${unnamedCount} unnamed questions < 6`);
  return questions;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AbChatRequest {
  endpoint: string;
  apiKey: string;
  body: unknown;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function classifyApiFailure(status: number, bodyText: string): Error {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    return new AbAuthError(`endpoint returned http-${status}: ${excerpt(bodyText)}`);
  }
  if (status === 404 || (lower.includes('model') && (lower.includes('not found') || lower.includes('不存在')))) {
    return new AbModelNotFoundError(`model unavailable http-${status}: ${excerpt(bodyText)}`);
  }
  return new Error(`endpoint returned http-${status}: ${excerpt(bodyText)}`);
}

/**
 * One chat-completions POST. Fail-loud taxonomy: 401/403 → AbAuthError,
 * model-not-found → AbModelNotFoundError, non-JSON 200 → AbBadShapeError,
 * transport failure → AbNetworkError. The API key never appears in any
 * thrown message (only in the Authorization header).
 */
export async function postChatCompletion(request: AbChatRequest): Promise<Record<string, unknown>> {
  const doFetch = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(request.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof AbAuthError || error instanceof AbModelNotFoundError) throw error;
    throw new AbNetworkError(`request to ${request.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw classifyApiFailure(response.status, text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AbBadShapeError(`non-JSON 200 response (len ${text.length}): ${excerpt(text)}`);
  }
  if (!isRecord(parsed)) throw new AbBadShapeError('200 response is not a JSON object');
  return parsed;
}
