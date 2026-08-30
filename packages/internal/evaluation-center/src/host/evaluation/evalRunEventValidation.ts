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
