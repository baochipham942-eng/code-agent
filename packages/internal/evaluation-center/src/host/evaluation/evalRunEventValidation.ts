import {
  EVAL_RUN_STAMP_KEYS,
  EVAL_RUN_EVENT_SCHEMA_VERSION,
  type EvalRunEvent,
} from '@shared/contract/evaluation';
import { isAiReviewDimension } from '@host/testing/judge/dimensions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requireString(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== 'string' || String(record[key]).length === 0) {
    throw new Error(`评测事件缺少字符串字段 ${key}。`);
  }
}

function requireNumber(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    throw new Error(`评测事件缺少数字字段 ${key}。`);
  }
}

function requireTestIdentity(record: Record<string, unknown>): void {
  requireString(record, 'testId');
}

function validateSummary(value: unknown): void {
  if (!isRecord(value)) throw new Error('评测结束事件缺少汇总。');
  requireString(value, 'runId');
  for (const key of [
    'startTime', 'endTime', 'duration', 'total', 'passed', 'failed', 'skipped',
    'partial', 'averageScore', 'notRun', 'invalidCases',
  ]) requireNumber(value, key);
  if (!isStringArray(value.plannedCaseIds)) throw new Error('评测汇总缺少 plannedCaseIds。');
  if (typeof value.completed !== 'boolean') throw new Error('评测汇总缺少 completed。');
  if (value.failureDistribution !== undefined) {
    if (!isRecord(value.failureDistribution)) throw new Error('评测汇总 failureDistribution 必须是对象。');
    for (const count of Object.values(value.failureDistribution)) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
        throw new Error('评测汇总 failureDistribution 含无效计数。');
      }
    }
  }
  if (
    value.failureCodebookSource !== undefined
    && value.failureCodebookSource !== 'project'
    && value.failureCodebookSource !== 'bundled'
  ) {
    throw new Error('评测汇总 failureCodebookSource 只能是 project 或 bundled。');
  }
  if (value.compare !== undefined) validateCompareSummary(value.compare);
}

function validateCompareArm(value: unknown): void {
  if (!isRecord(value)) throw new Error('实验配置必须是对象。');
  requireString(value, 'name');
  for (const key of ['model', 'provider', 'systemPrompt', 'reasoningEffort']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`实验配置字段 ${key} 格式不正确。`);
    }
  }
  if (value.skills !== undefined && !isStringArray(value.skills)) {
    throw new Error('实验配置 skills 必须是字符串数组。');
  }
  if (value.orchestration !== undefined) {
    if (!isRecord(value.orchestration)) throw new Error('实验配置 orchestration 必须是对象。');
    const { allowSwarm, spawnMaxDepth } = value.orchestration;
    if (allowSwarm !== undefined && typeof allowSwarm !== 'boolean') {
      throw new Error('实验配置 orchestration.allowSwarm 必须是布尔值。');
    }
    if (spawnMaxDepth !== undefined && (!Number.isInteger(spawnMaxDepth) || (spawnMaxDepth as number) < 0)) {
      throw new Error('实验配置 orchestration.spawnMaxDepth 必须是非负整数。');
    }
  }
}

function validateShipGate(value: unknown): void {
  if (!isRecord(value)) throw new Error('实验结论缺少 shipGate。');
  if (!['candidate_better', 'non_inferior', 'candidate_worse', 'insufficient'].includes(String(value.state))) {
    throw new Error('实验结论状态不受支持。');
  }
  for (const key of ['delta', 'nMin', 'decisivePairs', 'pValue', 'passRateDiff', 'ciLowerBound']) {
    requireNumber(value, key);
  }
  if (!isRecord(value.hardGate) || typeof value.hardGate.passed !== 'boolean' || !Array.isArray(value.hardGate.items)) {
    throw new Error('实验结论 hardGate 格式不正确。');
  }
  if (!isRecord(value.calibre)) throw new Error('实验结论 calibre 格式不正确。');
  requireNumber(value.calibre, 'k');
  requireNumber(value.calibre, 'aggregationRuleVersion');
  requireString(value.calibre, 'promptVersion');
  if (!isStringArray(value.reasons)) throw new Error('实验结论 reasons 格式不正确。');
}

function validateCompareSummary(value: unknown): void {
  if (!isRecord(value)) throw new Error('实验汇总格式不正确。');
  for (const key of [
    'totalCases', 'baselineWins', 'candidateWins', 'ties', 'excludedPairs',
    'skillNotActivatedPairs', 'pValue',
  ]) requireNumber(value, key);
  validateShipGate(value.shipGate);
}

function validateTrialAggregate(value: unknown): void {
  if (!isRecord(value)) throw new Error('评测用例 trialAggregate 格式不正确。');
  for (const key of ['n', 'c', 'passAtK', 'passCaretK']) requireNumber(value, key);
  if (value.rule !== 'pass_caret_k') throw new Error('评测用例 trialAggregate 计分规则不受支持。');
}

function validateAiReview(value: unknown): void {
  if (!isRecord(value)) throw new Error('评测用例 aiReview 格式不正确。');
  for (const [dimension, rawVerdict] of Object.entries(value)) {
    if (!isAiReviewDimension(dimension) || !isRecord(rawVerdict)) {
      throw new Error('评测用例 aiReview 含未知维度或无效结果。');
    }
    if (!['yes', 'no', 'unavailable'].includes(String(rawVerdict.verdict))) {
      throw new Error('评测用例 aiReview verdict 不受支持。');
    }
    for (const key of ['reasoning', 'judgeModel', 'promptHash']) requireString(rawVerdict, key);
    if (rawVerdict.reason !== undefined && !['no_expectation', 'judge_error', 'parse_error'].includes(String(rawVerdict.reason))) {
      throw new Error('评测用例 aiReview reason 不受支持。');
    }
  }
}

function validateEvidence(value: unknown): void {
  if (!isRecord(value)) throw new Error('评测用例 evidence 格式不正确。');
  if (!Array.isArray(value.checks)) throw new Error('评测用例 evidence.checks 必须是数组。');
  if (typeof value.responseExcerpt !== 'string') {
    throw new Error('评测用例 evidence.responseExcerpt 必须是字符串。');
  }
}

export function parseEvalRunEvent(value: unknown): EvalRunEvent {
  if (!isRecord(value)) throw new Error('评测事件不是对象。');
  if (value.schemaVersion !== EVAL_RUN_EVENT_SCHEMA_VERSION) {
    throw new Error(`评测事件版本不匹配，需要版本 ${EVAL_RUN_EVENT_SCHEMA_VERSION}。`);
  }
  requireString(value, 'type');
  requireString(value, 'runId');
  requireNumber(value, 'ts');

  switch (value.type) {
    case 'run_start': {
      if (!isStringArray(value.plannedCaseIds)) throw new Error('评测开始事件缺少 plannedCaseIds。');
      if (!isRecord(value.config)) throw new Error('评测开始事件缺少 config。');
      const config = value.config;
      if (config.mode !== 'real' && config.mode !== 'mock') throw new Error('评测模式不受支持。');
      if (config.scope !== 'smoke' && config.scope !== 'full') throw new Error('评测范围不受支持。');
      for (const key of ['model', 'provider', 'gitCommit', 'testCaseDir']) requireString(config, key);
      for (const key of ['maxCases', 'concurrency']) requireNumber(config, key);
      for (const key of EVAL_RUN_STAMP_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(config, key) || config[key] === undefined || config[key] === null) {
          throw new Error(`评测开始事件缺少本轮配置 ${key}。`);
        }
        if (typeof config[key] === 'string' && config[key].length === 0) {
          throw new Error(`评测开始事件的本轮配置 ${key} 为空。`);
        }
        if (isRecord(config[key]) && Object.keys(config[key]).length === 0) {
          throw new Error(`评测开始事件的本轮配置 ${key} 为空。`);
        }
      }
      if (config.compare !== undefined) {
        if (!isRecord(config.compare)) throw new Error('评测开始事件 compare 格式不正确。');
        validateCompareArm(config.compare.baseline);
        validateCompareArm(config.compare.candidate);
        if (!isStringArray(config.compare.diff)) throw new Error('评测开始事件 compare.diff 格式不正确。');
      }
      break;
    }
    case 'case_start':
      requireTestIdentity(value);
      requireString(value, 'description');
      break;
    case 'case_end': {
      requireTestIdentity(value);
      const statuses = new Set([
        'pending', 'running', 'passed', 'failed', 'skipped', 'partial',
        'infra_excluded', 'cost_exceeded', 'not_run',
      ]);
      if (!statuses.has(String(value.status))) throw new Error('评测用例状态不受支持。');
      requireNumber(value, 'score');
      requireNumber(value, 'durationMs');
      if (value.skillActivations !== undefined) {
        if (!isRecord(value.skillActivations)) {
          throw new Error('评测用例 skillActivations 必须是对象。');
        }
        for (const [name, count] of Object.entries(value.skillActivations)) {
          if (name.length === 0 || !Number.isInteger(count) || (count as number) < 0) {
            throw new Error('评测用例 skillActivations 含无效计数。');
          }
        }
      }
      if (value.subagentSpawns !== undefined
        && (!Number.isInteger(value.subagentSpawns) || (value.subagentSpawns as number) < 0)) {
        throw new Error('评测用例 subagentSpawns 必须是非负整数。');
      }
      if (value.aiReview !== undefined) validateAiReview(value.aiReview);
      if (value.evidence !== undefined) validateEvidence(value.evidence);
      if (value.invalid !== undefined) {
        if (!isRecord(value.invalid)) throw new Error('评测用例 invalid 必须是对象。');
        requireString(value.invalid, 'reason');
        if (value.invalid.reason !== 'usage_unavailable' && value.invalid.reason !== 'mock_excluded') {
          throw new Error('评测用例 invalid.reason 不受支持。');
        }
      }
      if (value.trialAggregate !== undefined) validateTrialAggregate(value.trialAggregate);
      if (value.failure !== undefined) {
        if (!isRecord(value.failure)) throw new Error('评测用例 failure 必须是对象。');
        requireString(value.failure, 'code');
        if (!isStringArray(value.failure.dispositions) || !isStringArray(value.failure.symptoms)) {
          throw new Error('评测用例 failure 缺少 dispositions 或 symptoms。');
        }
      }
      break;
    }
    case 'pair_end': {
      requireTestIdentity(value);
      if (!isRecord(value.assignment)) throw new Error('成对结果缺少盲分配。');
      if (!['baseline', 'candidate'].includes(String(value.assignment.A))
        || !['baseline', 'candidate'].includes(String(value.assignment.B))
        || value.assignment.A === value.assignment.B) {
        throw new Error('成对结果盲分配格式不正确。');
      }
      if (!['baseline', 'candidate', 'tie'].includes(String(value.assertionWinner))) {
        throw new Error('成对结果 assertionWinner 不受支持。');
      }
      if (!['A', 'B', 'tie'].includes(String(value.referenceWinner))) {
        throw new Error('成对结果 referenceWinner 不受支持。');
      }
      for (const key of ['assertionPassA', 'assertionPassB', 'assertionCount']) requireNumber(value, key);
      if (!isRecord(value.skillActivations)) throw new Error('成对结果缺少 skillActivations。');
      requireNumber(value.skillActivations, 'baseline');
      requireNumber(value.skillActivations, 'candidate');
      if (!isRecord(value.subagentSpawns)) throw new Error('成对结果缺少 subagentSpawns。');
      requireNumber(value.subagentSpawns, 'baseline');
      requireNumber(value.subagentSpawns, 'candidate');
      break;
    }
    case 'tool_call':
      requireTestIdentity(value);
      requireString(value, 'tool');
      if (!Object.prototype.hasOwnProperty.call(value, 'input')) throw new Error('工具调用事件缺少 input。');
      break;
    case 'tool_result':
      requireTestIdentity(value);
      requireString(value, 'tool');
      if (typeof value.success !== 'boolean') throw new Error('工具结果事件缺少 success。');
      break;
    case 'error':
      requireString(value, 'error');
      break;
    case 'run_end':
      validateSummary(value.summary);
      if (!isStringArray(value.reportFiles)) throw new Error('评测结束事件缺少 reportFiles。');
      requireNumber(value, 'exitCode');
      if (typeof value.aborted !== 'boolean') throw new Error('评测结束事件缺少 aborted。');
      if (value.error !== undefined && typeof value.error !== 'string') throw new Error('评测结束事件 error 格式不正确。');
      break;
    case 'skill_activated':
      requireTestIdentity(value);
      requireString(value, 'name');
      break;
    case 'memory_injected':
    case 'subagent_spawned':
      requireTestIdentity(value);
      requireString(value, 'id');
      break;
    default:
      throw new Error(`评测事件类型不受支持：${String(value.type)}`);
  }
  return value as unknown as EvalRunEvent;
}
