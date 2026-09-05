import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiReviewDimension, EvalRunStamp } from '@shared/contract/evaluation';
import { PROMPT_VERSION } from '@shared/constants/agent';
import { CONFIG_DIR_NEW } from '@shared/constants/configDir';
import { AGGREGATION_RULES } from '@host/testing/ci/baselineManager';
import { resolveProductionShape } from '../../src/host/evaluation/productionShape';
import { getQuickModelInfo } from '@host/model/quickModel';
import { estimateRunCost, PRICING_TABLE_VERSION } from './eval-cost-estimate';
import { resolveAnswerSideRoot } from '@host/testing/answerSide';
import { splitsPath } from '@host/testing/ci/sampleSplits';

const PROVIDER_KEY_CANDIDATES: Record<string, string[]> = {
  moonshot: ['KIMI_K25_API_KEY', 'MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
};

export function getProviderKeyCandidates(provider: string): string[] {
  return PROVIDER_KEY_CANDIDATES[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
}

export interface LoadedApiKey {
  value: string;
  source: EvalRunStamp['keySource'];
}

export function selectRunStamp(source: EvalRunStamp): EvalRunStamp {
  return {
    caseBankSha: source.caseBankSha,
    answerSideSha: source.answerSideSha,
    evalSet: source.evalSet,
    scorers: source.scorers,
    k: source.k,
    aggregationRuleVersion: source.aggregationRuleVersion,
    promptVersion: source.promptVersion,
    shape: source.shape,
    divergesFromProduction: source.divergesFromProduction,
    keySource: source.keySource,
    priceTableVersion: source.priceTableVersion,
    estimatedCostUsd: source.estimatedCostUsd,
  };
}

function readEnvValue(filePath: string, name: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(new RegExp(`^${name}=["']?([^"'\\s\\n]+)["']?`, 'm'));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export function loadApiKey(
  provider: string,
  workingDir: string,
  homeDir = os.homedir(),
): LoadedApiKey | undefined {
  const candidates = getProviderKeyCandidates(provider);
  const files: Array<{ path: string; label: string }> = [
    { path: path.join(workingDir, '.env'), label: path.join(workingDir, '.env') },
    { path: path.join(homeDir, '.code-agent', '.env'), label: '~/.code-agent/.env' },
  ];

  for (const name of candidates) {
    const environmentValue = process.env[name];
    if (environmentValue) return { value: environmentValue, source: `env:${name}` };
    for (const file of files) {
      const value = readEnvValue(file.path, name);
      if (value) return { value, source: `file:${file.label}` };
    }
  }
  return undefined;
}

export function resolveEvalApiKey(provider: string, workingDir: string): LoadedApiKey | undefined {
  const injected = process.env.AUTO_TEST_API_KEY;
  return injected
    ? { value: injected, source: 'env:AUTO_TEST_API_KEY' }
    : loadApiKey(provider, workingDir);
}

function gitOutput(repoDir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function resolveRepoRoot(workingDir: string): string | undefined {
  return gitOutput(workingDir, ['rev-parse', '--show-toplevel']);
}

function repoRelativePath(repoRoot: string, target: string): string | undefined {
  let canonicalRoot = path.resolve(repoRoot);
  let canonicalTarget = path.resolve(target);
  try {
    canonicalRoot = fs.realpathSync(canonicalRoot);
    canonicalTarget = fs.realpathSync(canonicalTarget);
  } catch {
    return undefined;
  }
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    return relative ? undefined : '.';
  }
  return relative.split(path.sep).join('/');
}

function resolveCaseBankSha(workingDir: string, testCaseDir: string): string {
  const repoRoot = resolveRepoRoot(workingDir);
  if (!repoRoot) return 'untracked';
  const relative = repoRelativePath(repoRoot, testCaseDir);
  if (!relative) return 'untracked';
  const sha = gitOutput(repoRoot, ['rev-parse', `HEAD:${relative}`]);
  if (!sha) return 'untracked';
  const dirty = gitOutput(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', relative]);
  return dirty ? `${sha}-dirty` : sha;
}

function contentSha(filePath: string): string {
  try {
    return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

function resolveSplitsFileSha(workingDir: string): string {
  return contentSha(splitsPath(workingDir));
}

function answerFiles(root: string): string[] {
  const answersRoot = path.join(root, 'answers');
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(answersRoot);
  return files.sort((left, right) => (
    path.relative(answersRoot, left).localeCompare(path.relative(answersRoot, right))
  ));
}

function resolveAnswerSideSha(workingDir: string): string {
  const root = resolveAnswerSideRoot(workingDir);
  if (!root) return 'missing';
  const answersRoot = path.join(root, 'answers');
  const hash = createHash('sha256');
  for (const filePath of answerFiles(root)) {
    hash.update(path.relative(answersRoot, filePath).split(path.sep).join('/'));
    hash.update(fs.readFileSync(filePath));
  }
  return `sha256:${hash.digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resolveCalibrationId(workingDir: string, judgeId: string): string {
  try {
    const registryPath = path.join(workingDir, CONFIG_DIR_NEW, 'judge-calibration.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    const record = registry[judgeId];
    if (!record) return 'uncalibrated';
    return `sha256:${createHash('sha256').update(stableJson(record)).digest('hex')}`;
  } catch {
    return 'uncalibrated';
  }
}

function divergentShapeKeys(
  actual: EvalRunStamp['shape'],
  production: EvalRunStamp['shape'],
): string[] {
  return (['skills', 'plugins', 'memory', 'swarm', 'harness'] as const)
    .filter((key) => stableJson(actual[key]) !== stableJson(production[key]));
}

export function buildRunStamp(opts: {
  workingDir: string;
  testCaseDir: string;
  mode: 'real' | 'mock';
  provider: string;
  model: string;
  split?: EvalRunStamp['evalSet']['split'];
  tags?: string[];
  ids?: string[];
  judge: 'rules' | 'llm';
  aiReview?: AiReviewDimension[];
  trialsPerCase?: number;
  shape: EvalRunStamp['shape'];
  estimatedCases: number;
}): EvalRunStamp {
  const aiReview = opts.aiReview ?? [];
  const judgeIdentity = opts.judge === 'llm' || aiReview.length > 0 ? getQuickModelInfo() : null;
  const judgeModel = judgeIdentity
    ? `${judgeIdentity.provider}/${judgeIdentity.model}`
    : opts.judge === 'rules' ? 'none' : 'unavailable';
  const keySource = opts.mode === 'real'
    ? resolveEvalApiKey(opts.provider, opts.workingDir)?.source ?? 'none'
    : 'none';
  const productionShape = resolveProductionShape(opts.model);

  return {
    caseBankSha: resolveCaseBankSha(opts.workingDir, opts.testCaseDir),
    answerSideSha: resolveAnswerSideSha(opts.workingDir),
    evalSet: {
      split: opts.split ?? 'all',
      splitsFileSha: resolveSplitsFileSha(opts.workingDir),
      tags: opts.tags ?? [],
      ids: opts.ids ?? [],
    },
    scorers: {
      deterministic: true,
      judge: opts.judge,
      judgeModel,
      judgeCalibrationId: judgeIdentity
        ? resolveCalibrationId(opts.workingDir, judgeModel)
        : 'uncalibrated',
      aiReview,
      aiReviewCalibration: Object.fromEntries(aiReview.map((dimension) => [
        dimension,
        judgeIdentity
          ? resolveCalibrationId(opts.workingDir, `${dimension}@${judgeModel}`)
          : 'uncalibrated',
      ])),
    },
    k: opts.trialsPerCase ?? 1,
    aggregationRuleVersion: AGGREGATION_RULES[
      (opts.trialsPerCase ?? 1) > 1 ? 'pass_caret_k' : 'pass_rate_k1'
    ].version,
    promptVersion: PROMPT_VERSION,
    shape: opts.shape,
    divergesFromProduction: divergentShapeKeys(opts.shape, productionShape),
    keySource,
    priceTableVersion: PRICING_TABLE_VERSION,
    estimatedCostUsd: opts.mode === 'mock' ? 0 : (
      estimateRunCost(opts.model, opts.estimatedCases)
      + (judgeIdentity ? estimateRunCost(judgeIdentity.model, opts.estimatedCases * aiReview.length) : 0)
    ),
  };
}
