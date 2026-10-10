import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CODE_AGENT_DATA_DIR = path.join(os.tmpdir(), `jev-route-${process.pid}`);

const routeKeys = vi.hoisted(() => ({
  typesafe: '',
  openrouter: undefined as string | undefined,
  openrouterReads: 0,
}));

const featureFlags = vi.hoisted(() => ({ jevSkillRerank: false }));
const quickTask = vi.hoisted(() => vi.fn(async () => ({
  success: true,
  content: '证据充分\n是',
  provider: 'p',
  model: 'm',
})));

vi.mock('../../../src/host/model/providers/providerResolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/model/providers/providerResolution')>();
  return {
    ...actual,
    resolveProviderApiKey: (config: { provider?: string }) => (
      config?.provider === 'typesafe' ? routeKeys.typesafe : ''
    ),
  };
});

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: (provider: string) => {
      if (provider !== 'openrouter') return undefined;
      routeKeys.openrouterReads += 1;
      return routeKeys.openrouter;
    },
  }),
}));

vi.mock('../../../src/host/services/cloud/featureFlagService', () => ({
  getFeatureFlagService: () => ({
    isEnabled: (name: string) => name === 'jev_skill_rerank' && featureFlags.jevSkillRerank,
  }),
}));

vi.mock('../../../src/host/model/quickModel', () => ({ quickTask }));

vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import { JEV_OPENROUTER_MODEL, MODEL_API_ENDPOINTS } from '../../../src/shared/constants/providers';
import {
  EVAL_JUDGE_QUALITY_QUESTION,
  JEV_MODEL,
  PERMCLASS_QUESTIONS,
} from '../../../src/shared/constants/jevQuestions';
import { resolveJevRoute, systemOne } from '../../../src/host/model/providers/typesafeProvider';
import { resolveBrowserJevStep } from '../../../src/host/agent/runtime/browser/jevBrowserStep';
import { scanWithJevInjection } from '../../../src/host/security/jevInjectionScan';
import { resetInputSanitizer } from '../../../src/host/security/inputSanitizer';
import { resolveJevSkillRerankOptions } from '../../../src/host/services/toolSearch/jevSkillRerank';
import { attachAiReview } from '../../../src/host/testing/testRunnerAiReview';
import type { TestCase, TestResult, TestRunnerConfig } from '../../../src/host/testing/types';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import type { ReplayBlock, StructuredReplay } from '../../../src/shared/contract/evaluationReplay';
import type { FailureCodebook } from '../../../src/host/testing/failureCodes';
import { runPostLaunchScoring, type PostLaunchScorerDeps } from '../../../src/host/testing/postlaunch/postLaunchScorer';
import { runJevRouteProbe } from '../../../scripts/acceptance/jev-route-probe';

const OFFICIAL = 'official-key-aaa';
const OPENROUTER = 'openrouter-key-bbb';
const STATE = { tool: 'Read', summary: 'read README.md' };
const QUESTIONS = {
  needs_human: PERMCLASS_QUESTIONS.needs_human,
  risk: PERMCLASS_QUESTIONS.risk,
  quality: EVAL_JUDGE_QUALITY_QUESTION,
};
const ANSWERS = {
  answers: {
    needs_human: { noul: 0.25 },
    risk: { choice: 'read_only', confidence: 0.91 },
    quality: { score: 1.2, confidence: 0.8, legend: { '0': 'low', '1': 'mid', '2': 'high' } },
  },
};

const NOW = Date.parse('2026-09-30T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const CODEBOOK = { version: 1, codes: [] } as unknown as FailureCodebook;

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;

function authorization(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return '';
  const record = headers as Record<string, string>;
  return record.Authorization ?? record.authorization ?? '';
}

function installFetch(body: unknown, status = 200): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return captured;
}

function expectOnlyKey(captured: CapturedRequest[], url: string, key: string, forbidden: string[]): void {
  expect(captured).toHaveLength(1);
  expect(captured[0].url).toBe(url);
  expect(authorization(captured[0].init)).toBe(`Bearer ${key}`);
  const serialized = JSON.stringify(captured[0]);
  for (const secret of forbidden) {
    expect(serialized).not.toContain(secret);
  }
}

async function catchError(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected systemOne to throw');
}

function memoryDb(): Database.Database {
  const database = new Database(':memory:');
  applySchema(database, LOGGER);
  applyTelemetrySchema(database, LOGGER);
  return database;
}

describe('typesafeProvider jev route', () => {
  beforeEach(() => {
    routeKeys.typesafe = '';
    routeKeys.openrouter = undefined;
    routeKeys.openrouterReads = 0;
    featureFlags.jevSkillRerank = false;
    quickTask.mockClear();
    vi.unstubAllEnvs();
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    resetInputSanitizer();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('official-only uses the official endpoint and key', async () => {
    routeKeys.typesafe = OFFICIAL;
    const captured = installFetch(ANSWERS);
    const answers = await systemOne(STATE, QUESTIONS);
    expect(resolveJevRoute()).toMatchObject({ kind: 'official', model: JEV_MODEL, apiKey: OFFICIAL });
    expectOnlyKey(captured, MODEL_API_ENDPOINTS.typesafeSystemOne, OFFICIAL, [OPENROUTER]);
    expect(routeKeys.openrouterReads).toBe(0);
    expect(answers).toEqual(ANSWERS.answers);
  });

  it('openrouter-only uses the decisions endpoint and OpenRouter key', async () => {
    routeKeys.openrouter = OPENROUTER;
    const captured = installFetch(ANSWERS);
    const answers = await systemOne(STATE, QUESTIONS);
    expect(resolveJevRoute()).toMatchObject({
      kind: 'openrouter',
      endpoint: MODEL_API_ENDPOINTS.openrouterDecisions,
      model: JEV_OPENROUTER_MODEL,
      apiKey: OPENROUTER,
    });
    expectOnlyKey(captured, MODEL_API_ENDPOINTS.openrouterDecisions, OPENROUTER, [OFFICIAL]);
    expect(JSON.parse(String(captured[0].init.body)).model).toBe(JEV_OPENROUTER_MODEL);
    expect(answers).toEqual(ANSWERS.answers);
  });

  it('both keys: official wins and the OpenRouter key is absent from the request', async () => {
    routeKeys.typesafe = OFFICIAL;
    routeKeys.openrouter = OPENROUTER;
    const captured = installFetch(ANSWERS);
    await systemOne(STATE, QUESTIONS);
    expect(resolveJevRoute()?.kind).toBe('official');
    expect(routeKeys.openrouterReads).toBe(0);
    expectOnlyKey(captured, MODEL_API_ENDPOINTS.typesafeSystemOne, OFFICIAL, [OPENROUTER]);
  });

  it('neither key returns null, throws KEY_MISSING, and does not fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(resolveJevRoute()).toBeNull();
    const error = await catchError(() => systemOne(STATE, QUESTIONS));
    expect(error.code).toBe('TYPESAFE_KEY_MISSING');
    expect(error.message).toContain('TYPESAFE_API_KEY');
    expect(error.message).toContain('OpenRouter key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blank keys are missing', async () => {
    routeKeys.typesafe = '   ';
    routeKeys.openrouter = '  ';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(resolveJevRoute()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenRouter body matches the official body except model', async () => {
    routeKeys.typesafe = OFFICIAL;
    const officialCaptured = installFetch(ANSWERS);
    await systemOne(STATE, QUESTIONS);
    const officialBody = JSON.parse(String(officialCaptured[0].init.body));

    routeKeys.typesafe = '';
    routeKeys.openrouter = OPENROUTER;
    const openrouterCaptured = installFetch(ANSWERS);
    await systemOne(STATE, QUESTIONS);
    const openrouterBody = JSON.parse(String(openrouterCaptured[0].init.body));

    expect(officialBody).toEqual({ state: STATE, model: JEV_MODEL, questions: QUESTIONS });
    expect(openrouterBody).toEqual({ ...officialBody, model: JEV_OPENROUTER_MODEL });
    expect(openrouterBody.model).toBe('typesafe/jev-1.13');
  });

  it('the same answers payload is returned for noul, choice, and score on both routes', async () => {
    routeKeys.typesafe = OFFICIAL;
    installFetch(ANSWERS);
    const official = await systemOne(STATE, QUESTIONS);

    routeKeys.typesafe = '';
    routeKeys.openrouter = OPENROUTER;
    installFetch(ANSWERS);
    const openrouter = await systemOne(STATE, QUESTIONS);

    expect(official).toEqual(ANSWERS.answers);
    expect(openrouter).toEqual(official);
    expect(official.needs_human).toEqual({ noul: 0.25 });
    expect(official.risk).toEqual({ choice: 'read_only', confidence: 0.91 });
    expect(official.quality).toMatchObject({ score: 1.2, confidence: 0.8 });
  });

  it.each([400, 404, 422])('HTTP %s is TYPESAFE_ROUTE_REJECTED', async (status) => {
    routeKeys.typesafe = OFFICIAL;
    installFetch(`no such model ${OFFICIAL}`, status);
    const error = await catchError(() => systemOne(STATE, QUESTIONS));
    expect(error.code).toBe('TYPESAFE_ROUTE_REJECTED');
    expect(error.message).toContain('model or endpoint rejected');
    expect(error.message).toContain('official');
    expect(error.message).toContain(String(status));
    expect(error.message).toContain(JEV_MODEL);
    expect(error.message).toContain(MODEL_API_ENDPOINTS.typesafeSystemOne);
    expect(error.message).not.toContain(OFFICIAL);
    expect(error.message).toContain('[redacted]');
  });

  it('HTTP 500 stays TYPESAFE_HTTP_ERROR and 401 is not route rejection', async () => {
    routeKeys.openrouter = OPENROUTER;
    installFetch('upstream down', 500);
    const server = await catchError(() => systemOne(STATE, QUESTIONS));
    expect(server.code).toBe('TYPESAFE_HTTP_ERROR');
    expect(server.message).toContain('HTTP 500');
    expect(server.message).not.toContain('model or endpoint rejected');

    installFetch('unauthorized', 401);
    const unauthorized = await catchError(() => systemOne(STATE, QUESTIONS));
    expect(unauthorized.code).toBe('TYPESAFE_HTTP_ERROR');
    expect(unauthorized.message).toContain('HTTP 401');
    expect(unauthorized.message).not.toContain('model or endpoint rejected');
  });

  it('KEY_MISSING, ROUTE_REJECTED, and HTTP_ERROR messages differ', async () => {
    const missing = await catchError(() => systemOne(STATE, QUESTIONS));
    routeKeys.typesafe = OFFICIAL;
    installFetch('rejected', 422);
    const rejected = await catchError(() => systemOne(STATE, QUESTIONS));
    installFetch('down', 500);
    const http = await catchError(() => systemOne(STATE, QUESTIONS));
    expect(missing.code).toBe('TYPESAFE_KEY_MISSING');
    expect(rejected.code).toBe('TYPESAFE_ROUTE_REJECTED');
    expect(http.code).toBe('TYPESAFE_HTTP_ERROR');
    expect(new Set([missing.message, rejected.message, http.message]).size).toBe(3);
  });

  it('OpenRouter 400 names the openrouter route', async () => {
    routeKeys.openrouter = OPENROUTER;
    installFetch('unknown model', 400);
    const error = await catchError(() => systemOne(STATE, QUESTIONS));
    expect(error.code).toBe('TYPESAFE_ROUTE_REJECTED');
    expect(error.message).toContain('openrouter');
    expect(error.message).toContain(JEV_OPENROUTER_MODEL);
    expect(error.message).toContain(MODEL_API_ENDPOINTS.openrouterDecisions);
    expect(error.message).not.toContain(OPENROUTER);
  });
});

describe('pre-checks treat an OpenRouter-only key as available', () => {
  beforeEach(() => {
    routeKeys.typesafe = '';
    routeKeys.openrouter = undefined;
    routeKeys.openrouterReads = 0;
    featureFlags.jevSkillRerank = false;
    quickTask.mockClear();
    vi.unstubAllEnvs();
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    resetInputSanitizer();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('browser step stays unwired with neither key and wires with OpenRouter only', () => {
    vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveBrowserJevStep()).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('TYPESAFE_API_KEY'));
      routeKeys.openrouter = OPENROUTER;
      expect(resolveBrowserJevStep()).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('injection scan stays unavailable with neither key and calls fetch with OpenRouter only', async () => {
    vi.stubEnv('CODE_AGENT_JEV_INJECTION_SCAN', '1');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(scanWithJevInjection('web_fetch', 'ordinary report')).resolves.toMatchObject({
      skipped: true,
      reason: 'unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    routeKeys.openrouter = OPENROUTER;
    const captured = installFetch({
      answers: { injection: { noul: 0.2 }, exfil_request: { noul: 0.1 } },
    });
    const result = await scanWithJevInjection('web_fetch', 'ordinary report');
    expect(result.skipped).toBe(false);
    expect(captured[0].url).toBe(MODEL_API_ENDPOINTS.openrouterDecisions);
    expect(authorization(captured[0].init)).toBe(`Bearer ${OPENROUTER}`);
  });

  it('post-launch prescreen stays unwired with neither key and calls fetch with OpenRouter only', async () => {
    vi.stubEnv('CODE_AGENT_POSTLAUNCH_JEV_PRESCREEN', '1');
    const database = memoryDb();
    database.prepare(`
      INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, session_type, origin_kind, agent_version, prompt_version)
      VALUES ('chat-1', 'chat-1', 'deepseek', 'deepseek-chat', '/ws', ?, 'chat', null, '0.33.0', 'p7')
    `).run(NOW - HOUR);
    database.prepare(`
      INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, end_time, duration_ms, turn_type, total_input_tokens, total_output_tokens)
      VALUES ('chat-turn-1', 'chat-1', 1, ?, ?, 1000, 'user', 100, 50)
    `).run(NOW - HOUR, NOW - HOUR + 1000);
    const replay = {
      sessionId: 'chat-1',
      turns: [{
        turnNumber: 1,
        turnType: 'user',
        blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR } as ReplayBlock],
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
        startTime: NOW - HOUR,
      }],
      summary: { totalTurns: 1 },
    } as unknown as StructuredReplay;
    const deps = (llmCall: PostLaunchScorerDeps['llmCall']): PostLaunchScorerDeps => ({
      db: database,
      getStructuredReplay: async () => replay,
      llmCall,
      estimateJudgeCostUsd: () => ({ usd: 0.1, assumed: false }),
      estimateTurnCostUsd: () => 0.001,
      fileExists: () => true,
      now: () => NOW,
      failureCodebook: CODEBOOK,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const llm = vi.fn(async () => '{"goal":{"pass":true,"why":""}}');
    try {
      await runPostLaunchScoring(deps(llm), { dailyBudgetUsd: 10 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(llm).toHaveBeenCalled();

      routeKeys.openrouter = OPENROUTER;
      llm.mockClear();
      const captured = installFetch({ answers: {} });
      await runPostLaunchScoring(deps(llm), { dailyBudgetUsd: 10 });
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].url).toBe(MODEL_API_ENDPOINTS.openrouterDecisions);
      expect(authorization(captured[0].init)).toBe(`Bearer ${OPENROUTER}`);
    } finally {
      database.close();
    }
  });

  it('dimension prescreen stays generative with neither key and calls fetch with OpenRouter only', async () => {
    vi.stubEnv('CODE_AGENT_DIMJUDGE_JEV_PRESCREEN', '1');
    const config: TestRunnerConfig = {
      testCaseDir: '/cases', resultsDir: '/results', workingDirectory: '/work',
      defaultTimeout: 1_000, stopOnFailure: false, verbose: false, parallel: false,
      maxParallel: 1, aiReview: ['task_completed'],
    };
    const testCase: TestCase = {
      id: 'case-1', type: 'task', description: '任务', prompt: '完成任务', expect: {},
    };
    const result = (): TestResult => ({
      testId: 'case-1', description: '任务', status: 'passed', score: 1,
      scoreAuthority: 'deterministic_assertion', duration: 1, startTime: 0, endTime: 1,
      toolExecutions: [], responses: [], errors: [], turnCount: 1,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const withoutKey = result();
    await attachAiReview(config, testCase, withoutKey, false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quickTask).toHaveBeenCalled();

    routeKeys.openrouter = OPENROUTER;
    quickTask.mockClear();
    const captured = installFetch({
      answers: { task_fulfilled: { noul: 0.9 }, claims_grounded: { noul: 0.9 } },
    });
    await attachAiReview(config, testCase, result(), false);
    expect(captured[0].url).toBe(MODEL_API_ENDPOINTS.openrouterDecisions);
    expect(authorization(captured[0].init)).toBe(`Bearer ${OPENROUTER}`);
    expect(quickTask).not.toHaveBeenCalled();
  });

  it('skill rerank stays unwired with neither key and wires with OpenRouter only', () => {
    featureFlags.jevSkillRerank = true;
    vi.stubEnv('CODE_AGENT_JEV_SKILL_RERANK', '1');
    expect(resolveJevSkillRerankOptions()).toBeUndefined();
    routeKeys.openrouter = OPENROUTER;
    expect(resolveJevSkillRerankOptions()).toMatchObject({ enabled: true });
  });
});

describe('jev-route-probe', () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const errorLog = (line: string) => { errors.push(line); };

  beforeEach(() => {
    lines.length = 0;
    errors.length = 0;
    routeKeys.typesafe = '';
    routeKeys.openrouter = undefined;
    routeKeys.openrouterReads = 0;
    vi.unstubAllEnvs();
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('prints SKIP no key and does not fetch when no key is set', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(runJevRouteProbe([], log, errorLog)).resolves.toBe(0);
    expect(lines).toEqual(['SKIP no key']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('default route prefers official and --route openrouter forces the other key', async () => {
    routeKeys.typesafe = OFFICIAL;
    routeKeys.openrouter = OPENROUTER;
    const official = installFetch(ANSWERS);
    await expect(runJevRouteProbe([], log, errorLog)).resolves.toBe(0);
    expect(official[0].url).toBe(MODEL_API_ENDPOINTS.typesafeSystemOne);
    expect(authorization(official[0].init)).toBe(`Bearer ${OFFICIAL}`);
    expect(JSON.stringify(official[0])).not.toContain(OPENROUTER);
    expect(lines.some((line) => line.startsWith('route kind=official'))).toBe(true);
    expect(lines.some((line) => line.includes('needs_human=noul'))).toBe(true);
    expect(lines.some((line) => line.includes('risk=choice'))).toBe(true);
    expect(lines.some((line) => line.includes('quality=score'))).toBe(true);
    expect(lines.join('\n')).not.toContain(OFFICIAL);

    lines.length = 0;
    const openrouter = installFetch(ANSWERS);
    await expect(runJevRouteProbe(['--route', 'openrouter'], log, errorLog)).resolves.toBe(0);
    expect(openrouter[0].url).toBe(MODEL_API_ENDPOINTS.openrouterDecisions);
    expect(authorization(openrouter[0].init)).toBe(`Bearer ${OPENROUTER}`);
    expect(JSON.stringify(openrouter[0])).not.toContain(OFFICIAL);
    expect(JSON.parse(String(openrouter[0].init.body)).model).toBe(JEV_OPENROUTER_MODEL);
  });

  it('--route official skips when only the OpenRouter key exists', async () => {
    routeKeys.openrouter = OPENROUTER;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(runJevRouteProbe(['--route=official'], log, errorLog)).resolves.toBe(0);
    expect(lines).toEqual(['SKIP no key']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
