// Real-judge eval: keyword baseline vs the production Jev skill-rerank factory.
// Report only. Does not change flag defaults.
//
// "Loaded skill" is the skill that would occupy loadedTools if skills were
// loadable. A fresh ToolSearchService keeps skill:* out of loadedTools
// (canExposeLoadedTool is false for source dynamic; protocol tools are
// unregistered). The auto-load predicate still runs: index 0, clear lead or
// sole hit, and no suppress. Rates use that predicate. Raw loadedTools is
// recorded beside it.
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DeferredToolMeta } from '../../src/shared/contract/toolSearch.ts';
import type { ToolSearchService } from '../../src/host/services/toolSearch/toolSearchService.ts';
import { resolveStepfunBaseUrl } from './stepfunEndpoint';

const spyUrl = new URL('./jev-skill-rerank-systemone-spy.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    if (specifier.includes('typesafeProvider') && !parent.includes('jev-skill-rerank-systemone-spy')) {
      return { url: spyUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const JEV_USD_ABORT = 1;
const JUDGE_ERROR_RATE_LIMIT = 0.1;
const OUT_JSON = 'docs/research/assets/2026-09-30-jev-eval/skill-rerank.json';
// Step Plan subscription (flat fee, per-token price 0).
const STEPFUN_PRICE = { inputPerMTok: 0, outputPerMTok: 0, baseURL: resolveStepfunBaseUrl(), model: 'step-3.5-flash-2603' };

type Kind = 'implicit' | 'negative' | 'chitchat';
type Origin = 'bank' | 'synthetic';

interface Sample {
  id: string;
  prompt: string;
  expected: string | null;
  kind: Kind;
  origin: Origin;
  adjacent?: boolean;
}

interface MetricRow {
  id: string;
  kind: Kind;
  expected: string | null;
  k: string[];
  j: string[];
}

interface Rate {
  count: number;
  total: number;
  rate: number;
}

interface ArmRates {
  misPick: Rate;
  extraLoad: Rate;
  miss: Rate;
}

interface BaselineChoice {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  baseURL: string;
}

function ratio(count: number, total: number): Rate {
  return { count, total, rate: total === 0 ? 0 : count / total };
}

function firstSkill(loaded: string[]): string | null {
  return loaded[0] ?? null;
}

function rowFlags(skill: string | null, expected: string | null, kind: Kind): { misPick: boolean; miss: boolean; extra: boolean } {
  const positive = kind === 'implicit';
  return {
    misPick: positive && skill !== null && skill !== expected,
    miss: positive && skill === null,
    extra: !positive && skill !== null,
  };
}

function armRates(rows: MetricRow[], arm: 'k' | 'j'): ArmRates {
  const positives = rows.filter((row) => row.kind === 'implicit');
  const rest = rows.filter((row) => row.kind !== 'implicit');
  let misPick = 0;
  let miss = 0;
  let extra = 0;
  for (const row of positives) {
    const flags = rowFlags(firstSkill(row[arm]), row.expected, row.kind);
    if (flags.misPick) misPick += 1;
    if (flags.miss) miss += 1;
  }
  for (const row of rest) {
    if (rowFlags(firstSkill(row[arm]), row.expected, row.kind).extra) extra += 1;
  }
  return {
    misPick: ratio(misPick, positives.length),
    extraLoad: ratio(extra, rest.length),
    miss: ratio(miss, positives.length),
  };
}

function rowRegressed(row: MetricRow): boolean {
  const before = rowFlags(firstSkill(row.k), row.expected, row.kind);
  const after = rowFlags(firstSkill(row.j), row.expected, row.kind);
  return (after.misPick && !before.misPick) || (after.miss && !before.miss) || (after.extra && !before.extra);
}

function recommendationOf(keyword: ArmRates, judged: ArmRates): '不接电' | '可接电候选' {
  if (judged.misPick.count > keyword.misPick.count || judged.miss.count > keyword.miss.count) return '不接电';
  return '可接电候选';
}

function skillBodyTokensSaved(rows: MetricRow[], tokens: ReadonlyMap<string, number>): number {
  let saved = 0;
  for (const row of rows) {
    const keyword = new Set(row.k);
    const judged = new Set(row.j);
    for (const name of keyword) if (!judged.has(name)) saved += tokens.get(name) ?? 0;
    for (const name of judged) if (!keyword.has(name)) saved -= tokens.get(name) ?? 0;
  }
  return saved;
}

function assertRates(label: string, actual: Rate, count: number, total: number): void {
  if (actual.count !== count || actual.total !== total) {
    throw new Error(`${label}: expected ${count}/${total}, got ${actual.count}/${actual.total}`);
  }
}

function selfCheck(): void {
  const rows: MetricRow[] = [
    { id: 'ok', kind: 'implicit', expected: 'xlsx', k: ['xlsx'], j: ['xlsx'] },
    { id: 'mis', kind: 'implicit', expected: 'xlsx', k: ['xlsx'], j: ['meeting-summary'] },
    { id: 'miss', kind: 'implicit', expected: 'xlsx', k: ['xlsx'], j: [] },
    { id: 'extra', kind: 'negative', expected: null, k: ['contract-review'], j: [] },
  ];
  const keyword = armRates(rows, 'k');
  const judged = armRates(rows, 'j');
  assertRates('K mis-pick', keyword.misPick, 0, 3);
  assertRates('J mis-pick', judged.misPick, 1, 3);
  assertRates('K miss', keyword.miss, 0, 3);
  assertRates('J miss', judged.miss, 1, 3);
  assertRates('K extra-load', keyword.extraLoad, 1, 1);
  assertRates('J extra-load', judged.extraLoad, 0, 1);
  if (recommendationOf(keyword, judged) !== '不接电') throw new Error('recommendation should refuse when J is worse');
  const tied: MetricRow[] = [{ id: 'tie', kind: 'implicit', expected: 'xlsx', k: ['xlsx'], j: ['xlsx'] }];
  if (recommendationOf(armRates(tied, 'k'), armRates(tied, 'j')) !== '可接电候选') {
    throw new Error('recommendation should stay a candidate when rates tie');
  }
  const regressed = rows.filter(rowRegressed).map((row) => row.id);
  if (regressed.join(',') !== 'mis,miss') throw new Error(`regressed rows: ${regressed.join(',')}`);
  const tokens = new Map([['xlsx', 100], ['meeting-summary', 40], ['contract-review', 80]]);
  const saved = skillBodyTokensSaved(rows, tokens);
  if (saved !== 240) throw new Error(`token delta ${saved}, expected 240`);
  console.log('self-check ok');
}

function keyState(name: string): 'set' | 'unset' {
  const value = process.env[name];
  return value && value.trim() ? 'set' : 'unset';
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadSamples(file: string): Sample[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) fail('fixture is not an array');
  const samples: Sample[] = [];
  const ids = new Set<string>();
  for (const item of parsed) {
    if (!isRecord(item)) fail('fixture row is not an object');
    const id = item.id;
    const prompt = item.prompt;
    const kind = item.kind;
    const origin = item.origin;
    const expected = item.expected;
    if (typeof id !== 'string' || typeof prompt !== 'string') fail('fixture row missing id or prompt');
    if (kind !== 'implicit' && kind !== 'negative' && kind !== 'chitchat') fail(`bad kind on ${id}`);
    if (origin !== 'bank' && origin !== 'synthetic') fail(`bad origin on ${id}`);
    if (expected !== null && typeof expected !== 'string') fail(`bad expected on ${id}`);
    if (ids.has(id)) fail(`duplicate id ${id}`);
    ids.add(id);
    const sample: Sample = { id, prompt, expected, kind, origin };
    if (item.adjacent === true) sample.adjacent = true;
    samples.push(sample);
  }
  const implicit = samples.filter((row) => row.kind === 'implicit');
  const negatives = samples.filter((row) => row.kind === 'negative');
  const chats = samples.filter((row) => row.kind === 'chitchat');
  const skills = new Set(implicit.map((row) => row.expected));
  if (samples.length < 60) fail(`fixture has ${samples.length} rows, need >= 60`);
  if (negatives.length < 20) fail(`negatives ${negatives.length}, need >= 20`);
  if (negatives.filter((row) => row.adjacent).length < 8) fail('adjacent negatives < 8');
  if (implicit.length < 30) fail(`implicit ${implicit.length}, need >= 30`);
  if (skills.size < 10) fail(`implicit skills ${skills.size}, need >= 10`);
  if (chats.length < 10) fail(`chitchat ${chats.length}, need >= 10`);
  if (samples.filter((row) => row.origin === 'bank').length !== 6) fail('bank rows must be 6');
  for (const row of implicit) if (!row.expected) fail(`implicit ${row.id} has no expected skill`);
  for (const row of samples) {
    if (row.kind !== 'implicit' && row.expected !== null) fail(`${row.id} should expect null`);
    if (row.prompt.startsWith('select:') || row.prompt.startsWith('+')) fail(`${row.id} is not keywords mode`);
  }
  return samples;
}

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
}

function gitHead(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim();
}

function percent(rate: Rate): string {
  const pct = rate.total === 0 ? '0.0' : (100 * rate.rate).toFixed(1);
  return `${rate.count}/${rate.total} (${pct}%)`;
}

function printArm(label: string, rates: ArmRates): void {
  console.log(`${label} mis-pick ${percent(rates.misPick)} | extra-load ${percent(rates.extraLoad)} | miss ${percent(rates.miss)}`);
}

interface SearchInternals {
  calculateKeywordScore(meta: DeferredToolMeta, keyword: string): number;
  skillsMeta: Map<string, DeferredToolMeta>;
  deferredToolIndex: Map<string, DeferredToolMeta>;
  mcpToolsMeta: Map<string, DeferredToolMeta>;
}

function asInternals(service: ToolSearchService): SearchInternals {
  return service as unknown as SearchInternals;
}

function findMeta(service: SearchInternals, name: string): DeferredToolMeta | undefined {
  return service.skillsMeta.get(name) ?? service.deferredToolIndex.get(name) ?? service.mcpToolsMeta.get(name);
}

function rawScore(service: ToolSearchService, internals: SearchInternals, meta: DeferredToolMeta, query: string): number {
  const mode = service.parseQuery(query);
  if (mode.type !== 'keyword') return 0;
  let score = 0;
  for (const keyword of mode.keywords) score += internals.calculateKeywordScore(meta, keyword);
  return score;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readChoice(value: unknown): { choice: string; confidence: number } | null {
  if (!value || typeof value !== 'object' || !('choice' in value)) return null;
  const record = value as { choice?: unknown; confidence?: unknown };
  if (typeof record.choice !== 'string' || !isUnitInterval(record.confidence)) return null;
  return { choice: record.choice, confidence: record.confidence };
}

function readNoul(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('noul' in value)) return null;
  const noul = (value as { noul?: unknown }).noul;
  return isUnitInterval(noul) ? noul : null;
}

function acceptDecision(answers: Record<string, unknown>, rosterNames: string[], thresholds: { minNeedSkill: number; minChoiceConfidence: number; minNeedNow: number; maxNoneOfRoster: number }): boolean {
  const choice = readChoice(answers.choice);
  const needSkill = readNoul(answers.need_skill);
  const needNow = readNoul(answers.need_now);
  const none = readNoul(answers.none_of_roster);
  if (!choice || needSkill === null || needNow === null || none === null) return false;
  if (needSkill < thresholds.minNeedSkill) return false;
  if (choice.confidence < thresholds.minChoiceConfidence) return false;
  if (needNow < thresholds.minNeedNow) return false;
  if (none > thresholds.maxNoneOfRoster) return false;
  return rosterNames.includes(choice.choice);
}

function collectSecrets(): string[] {
  const names = ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'STEPFUN_API_KEY', 'MOONSHOT_API_KEY', 'LONGCAT_API_KEY'];
  const secrets: string[] = [];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length >= 6) secrets.push(value);
  }
  return secrets;
}

function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

async function probeModel(baseURL: string, apiKey: string, model: string, secrets: string[]): Promise<boolean> {
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const { generateText } = await import('ai');
  const provider = createOpenAICompatible({ name: 'jev-skill-rerank-baseline', baseURL, apiKey });
  try {
    await generateText({
      model: provider(model),
      prompt: 'ping',
      maxOutputTokens: 1,
      abortSignal: AbortSignal.timeout(20_000),
    });
    return true;
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), secrets).slice(0, 180);
    console.error(`probe failed ${model}: ${message}`);
    return false;
  }
}

async function resolveBaseline(secrets: string[]): Promise<BaselineChoice> {
  const { MODEL_API_ENDPOINTS } = await import('../../src/shared/constants/providers.ts');
  const { resolveModelPrice } = await import('../../src/shared/pricing/resolveModelPrice.ts');
  const deepseek = resolveModelPrice('deepseek', 'deepseek-v4-flash');
  if (deepseek.inputPerMTok == null || deepseek.outputPerMTok == null) {
    fail('deepseek-v4-flash catalog price is null');
  }
  console.log(`deepseek catalog inputPerMTok=${deepseek.inputPerMTok}`);
  if (keyState('DEEPSEEK_API_KEY') === 'set') {
    const key = process.env.DEEPSEEK_API_KEY ?? '';
    if (await probeModel(MODEL_API_ENDPOINTS.deepseek, key, 'deepseek-v4-flash', secrets)) {
      console.log('baseline model: deepseek/deepseek-v4-flash');
      return {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputPerMTok: deepseek.inputPerMTok,
        outputPerMTok: deepseek.outputPerMTok,
        baseURL: MODEL_API_ENDPOINTS.deepseek,
      };
    }
  } else {
    console.log('DEEPSEEK_API_KEY: unset');
  }
  if (keyState('STEPFUN_API_KEY') === 'set') {
    const key = process.env.STEPFUN_API_KEY ?? '';
    if (await probeModel(STEPFUN_PRICE.baseURL, key, STEPFUN_PRICE.model, secrets)) {
      console.log(`baseline model: stepfun/${STEPFUN_PRICE.model}`);
      return {
        provider: 'stepfun',
        model: STEPFUN_PRICE.model,
        inputPerMTok: STEPFUN_PRICE.inputPerMTok,
        outputPerMTok: STEPFUN_PRICE.outputPerMTok,
        baseURL: STEPFUN_PRICE.baseURL,
      };
    }
  }
  const moonshot = resolveModelPrice('moonshot', 'kimi-k2.6');
  if (keyState('MOONSHOT_API_KEY') === 'set' && moonshot.inputPerMTok != null && moonshot.outputPerMTok != null) {
    const key = process.env.MOONSHOT_API_KEY ?? '';
    if (await probeModel(MODEL_API_ENDPOINTS.moonshot, key, 'kimi-k2.6', secrets)) {
      console.log('baseline model: moonshot/kimi-k2.6');
      return {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        inputPerMTok: moonshot.inputPerMTok,
        outputPerMTok: moonshot.outputPerMTok,
        baseURL: MODEL_API_ENDPOINTS.moonshot,
      };
    }
  }
  const longcat = resolveModelPrice('longcat', 'LongCat-2.0');
  if (keyState('LONGCAT_API_KEY') === 'set' && longcat.inputPerMTok != null && longcat.outputPerMTok != null) {
    const key = process.env.LONGCAT_API_KEY ?? '';
    if (await probeModel(MODEL_API_ENDPOINTS.longcat, key, 'LongCat-2.0', secrets)) {
      console.log('baseline model: longcat/LongCat-2.0');
      return {
        provider: 'longcat',
        model: 'LongCat-2.0',
        inputPerMTok: longcat.inputPerMTok,
        outputPerMTok: longcat.outputPerMTok,
        baseURL: MODEL_API_ENDPOINTS.longcat,
      };
    }
  }
  fail('no baseline model: deepseek probe failed and StepFun/Moonshot/LongCat were unset or rejected');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) {
    selfCheck();
    return;
  }
  const fixture = args.find((arg) => !arg.startsWith('--'));
  if (!fixture) fail('usage: npx tsx scripts/acceptance/jev-skill-rerank-eval.ts <samples.json>');
  const root = repoRoot();
  const samples = loadSamples(path.resolve(fixture));
  console.log(`TYPESAFE_API_KEY: ${keyState('TYPESAFE_API_KEY')}`);
  if (keyState('TYPESAFE_API_KEY') === 'unset') fail('refusing to run: TYPESAFE_API_KEY is unset');
  const { JEV_MODEL, JEV_SKILL_RERANK_THRESHOLDS } = await import('../../src/shared/constants/jevQuestions.ts');
  if (JEV_MODEL !== 'jev-1.13.0') fail(`JEV_MODEL is ${JEV_MODEL}, expected jev-1.13.0`);
  console.log(`JEV_MODEL=${JEV_MODEL}`);

  const secrets = collectSecrets();
  const baseline = await resolveBaseline(secrets);
  if (!Number.isFinite(baseline.inputPerMTok)) fail('resolved baseline input price is null');

  const { getCloudConfigService } = await import('../../src/host/services/cloud/cloudConfigService.ts');
  const { resolveJevSkillRerankOptions } = await import('../../src/host/services/toolSearch/jevSkillRerank.ts');
  const { ToolSearchService } = await import('../../src/host/services/toolSearch/toolSearchService.ts');
  const { BUILTIN_SKILLS } = await import('../../src/host/services/skills/builtinSkillsData.ts');
  const { estimateTokens } = await import('../../src/host/context/tokenEstimator.ts');
  const { DEFERRED_TOOL_LOADING } = await import('../../src/shared/constants/tools.ts');
  const { systemOneSpy } = await import('./jev-skill-rerank-systemone-spy.ts');

  const known = new Set(BUILTIN_SKILLS.map((skill) => skill.name));
  for (const sample of samples) {
    if (sample.expected && !known.has(sample.expected)) fail(`unknown skill ${sample.expected} on ${sample.id}`);
  }

  process.env.CODE_AGENT_JEV_SKILL_RERANK = '1';
  getCloudConfigService().getConfig().featureFlags.jev_skill_rerank = true;
  const wired = resolveJevSkillRerankOptions();
  if (!wired?.enabled || !wired.judge) fail('production rerank factory returned no judge');

  const service = new ToolSearchService();
  service.registerSkills(BUILTIN_SKILLS.map((skill) => ({ name: skill.name, description: skill.description })));
  const internals = asInternals(service);
  const tokenBySkill = new Map(BUILTIN_SKILLS.map((skill) => [skill.name, estimateTokens(skill.promptContent)]));
  const gap = DEFERRED_TOOL_LOADING.CLEAR_LEAD_SCORE_GAP;

  interface ArmSnap {
    loadedSkills: string[];
    rawLoadedTools: string[];
    top: string | null;
    totalCount: number;
    suppressed?: boolean;
  }

  function skillLoaded(query: string, topName: string | null, secondName: string | null, totalCount: number, suppressed: boolean): string[] {
    if (suppressed || !topName?.startsWith('skill:')) return [];
    if (totalCount !== 1 && !secondName) return [];
    const topMeta = findMeta(internals, topName);
    if (!topMeta) return [];
    let clearly = totalCount === 1;
    if (!clearly && secondName) {
      const secondMeta = findMeta(internals, secondName);
      if (!secondMeta) return [];
      const lead = rawScore(service, internals, topMeta, query) - rawScore(service, internals, secondMeta, query);
      clearly = lead >= gap;
    }
    return clearly ? [topName.slice('skill:'.length)] : [];
  }

  const rows: Array<MetricRow & { origin: Origin; adjacent?: boolean; K: ArmSnap; J: ArmSnap; judge: unknown[] }> = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample) continue;
    if (systemOneSpy.usd > JEV_USD_ABORT) fail(`abort: running Jev usd ${systemOneSpy.usd.toFixed(4)} exceeds ${JEV_USD_ABORT}`);
    const rowsLeft = samples.length - index;
    const bad = systemOneSpy.errors + systemOneSpy.badShapes;
    const bestCalls = systemOneSpy.calls + rowsLeft * 2;
    if (bestCalls > 0 && bad / bestCalls > JUDGE_ERROR_RATE_LIMIT) {
      fail(`abort: judge error/bad-shape ${bad} cannot fall to <= ${JUDGE_ERROR_RATE_LIMIT} of remaining calls`);
    }

    service.resetLoadedTools();
    const keywordResult = await service.searchTools(sample.prompt, {
      includeMCP: true,
      sessionId: `eval-${sample.id}-K`,
    });
    const keywordSnap: ArmSnap = {
      loadedSkills: skillLoaded(sample.prompt, keywordResult.tools[0]?.name ?? null, keywordResult.tools[1]?.name ?? null, keywordResult.totalCount, false),
      rawLoadedTools: [...keywordResult.loadedTools],
      top: keywordResult.tools[0]?.name ?? null,
      totalCount: keywordResult.totalCount,
    };

    const traceFrom = systemOneSpy.traces.length;
    service.resetLoadedTools();
    const judgedResult = await service.searchTools(sample.prompt, {
      includeMCP: true,
      sessionId: `eval-${sample.id}-J`,
      rerank: wired,
    });
    const traces = systemOneSpy.traces.slice(traceFrom);
    const suppressed = traces.length > 0
      && traces.every((trace) => !trace.error && !trace.badShape)
      && (() => {
        const first = traces[0];
        if (!first?.answers || !acceptDecision(first.answers, first.rosterNames, JEV_SKILL_RERANK_THRESHOLDS)) return true;
        const second = traces[1];
        if (!second?.answers) return true;
        return !acceptDecision(second.answers, second.rosterNames, JEV_SKILL_RERANK_THRESHOLDS);
      })();
    const judgedSnap: ArmSnap = {
      loadedSkills: skillLoaded(sample.prompt, judgedResult.tools[0]?.name ?? null, judgedResult.tools[1]?.name ?? null, judgedResult.totalCount, suppressed),
      rawLoadedTools: [...judgedResult.loadedTools],
      top: judgedResult.tools[0]?.name ?? null,
      totalCount: judgedResult.totalCount,
      suppressed,
    };
    rows.push({
      id: sample.id,
      kind: sample.kind,
      expected: sample.expected,
      origin: sample.origin,
      ...(sample.adjacent ? { adjacent: true } : {}),
      k: keywordSnap.loadedSkills,
      j: judgedSnap.loadedSkills,
      K: keywordSnap,
      J: judgedSnap,
      judge: traces.map((trace) => {
        const choice = trace.answers ? readChoice(trace.answers.choice) : null;
        return {
          choice: choice?.choice,
          confidence: choice?.confidence,
          needSkill: trace.answers ? readNoul(trace.answers.need_skill) : null,
          needNow: trace.answers ? readNoul(trace.answers.need_now) : null,
          noneOfRoster: trace.answers ? readNoul(trace.answers.none_of_roster) : null,
          badShape: trace.badShape,
          ...(trace.error ? { error: trace.error } : {}),
          usd: Number(trace.usd.toFixed(8)),
        };
      }),
    });
    console.log(`row ${index + 1}/${samples.length} ${sample.id} calls=${systemOneSpy.calls} jevUsd=${systemOneSpy.usd.toFixed(4)}`);
  }

  const bad = systemOneSpy.errors + systemOneSpy.badShapes;
  if (systemOneSpy.calls > 0 && bad / systemOneSpy.calls > JUDGE_ERROR_RATE_LIMIT) {
    fail(`judge error/bad-shape ${bad}/${systemOneSpy.calls} exceeds ${JUDGE_ERROR_RATE_LIMIT}; JSON not written`);
  }
  if (systemOneSpy.usd > JEV_USD_ABORT) fail(`abort: running Jev usd ${systemOneSpy.usd.toFixed(4)} exceeds ${JEV_USD_ABORT}`);

  const keywordRates = armRates(rows, 'k');
  const judgedRates = armRates(rows, 'j');
  const savedTokens = skillBodyTokensSaved(rows, tokenBySkill);
  const savedUsd = (savedTokens / 1_000_000) * baseline.inputPerMTok;
  const verdict = recommendationOf(keywordRates, judgedRates);
  const regressed = rows.filter(rowRegressed).map((row) => row.id);
  printArm('K', keywordRates);
  printArm('J', judgedRates);
  console.log(`skillBodyTokensSaved=${savedTokens} skillBodyUsd=${savedUsd.toFixed(6)} jevUsd=${systemOneSpy.usd.toFixed(6)} baseline=${baseline.provider}/${baseline.model}`);
  console.log(`judgeCalls=${systemOneSpy.calls} errors=${systemOneSpy.errors} badShape=${systemOneSpy.badShapes}`);
  console.log(`regressed: ${regressed.join(', ') || '(none)'}`);
  console.log(`recommendation: ${verdict} (${verdict === '不接电' ? 'do not turn on' : 'candidate to turn on'})`);
  console.log('cookbook reference (not a gate): 16.8%->7.3% / 9.8%->4.0%');

  const payload = {
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(root),
    JEV_MODEL,
    loadDefinition: 'skill at tools[0] when the auto-load predicate is true (sole hit or clear lead, not suppressed). raw loadedTools stays empty for skill:* on a fresh service.',
    baselineModel: {
      provider: baseline.provider,
      model: baseline.model,
      inputPerMTok: baseline.inputPerMTok,
      outputPerMTok: baseline.outputPerMTok,
    },
    summary: {
      K: keywordRates,
      J: judgedRates,
      skillBodyTokensSaved: savedTokens,
      skillBodyUsd: savedUsd,
      jevUsd: systemOneSpy.usd,
      judgeCalls: systemOneSpy.calls,
      judgeErrors: systemOneSpy.errors,
      judgeBadShapes: systemOneSpy.badShapes,
      recommendation: verdict,
      regressed,
    },
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      origin: row.origin,
      expected: row.expected,
      ...(row.adjacent ? { adjacent: true } : {}),
      regressed: rowRegressed(row),
      K: row.K,
      J: row.J,
      judge: row.judge,
    })),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (collectSecrets().some((secret) => text.includes(secret))) fail('refusing to write JSON: key material in payload');
  const outPath = path.join(root, OUT_JSON);
  const tmpPath = `${outPath}.tmp`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    fs.writeFileSync(tmpPath, text);
    fs.renameSync(tmpPath, outPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
  console.log(`wrote ${OUT_JSON}`);
}

main().catch((error: unknown) => {
  const secrets = collectSecrets();
  const message = redactText(error instanceof Error ? error.message : String(error), secrets);
  console.error(message);
  process.exit(1);
});
