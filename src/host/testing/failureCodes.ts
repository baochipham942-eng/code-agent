import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import { isTransientError } from '../model/providers/retryStrategy';

const FAILURE_CODEBOOK_FILE = 'eval-failcodes.yaml';
const STDERR_TAIL_LINES = 20;
const moduleDir = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_FAILURE_CODEBOOK_DIR = path.resolve(moduleDir, '../../../.claude');

interface FailureCodeMatch {
  failureReason?: string[];
  failureStage?: string[];
  status?: string[];
  stderr?: string[];
}

interface FailureCodeDefinition {
  code: string;
  label: string;
  priority: number;
  match: FailureCodeMatch;
  dispositions: string[];
  issue?: string;
  note?: string;
}

export interface FailureCodebook {
  version: 1;
  codes: FailureCodeDefinition[];
}

interface LoadedProjectFailureCodebook {
  codebook: FailureCodebook;
  source: 'project' | 'bundled';
}

interface FailureClassificationInput {
  failureReason?: string;
  failureStage?: string;
  status?: string;
  stderr?: string | string[];
}

interface FailureClassification {
  primaryFailureCode: string;
  dispositions: string[];
  matched: string[];
}

function failCodebook(filePath: string, message: string, cause?: unknown): never {
  const prefix = `失败原因码本 ${filePath} 无法使用：${message}`;
  if (cause !== undefined) throw new Error(prefix, { cause });
  throw new Error(prefix);
}

function stringArray(
  value: unknown,
  field: string,
  filePath: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return failCodebook(filePath, `${field} 必须是${allowEmpty ? '' : '非空'}字符串数组`);
  }
  const strings: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return failCodebook(filePath, `${field} 只能包含非空字符串`);
    }
    strings.push(item);
  }
  return strings;
}

function validateRegexes(patterns: string[], field: string, filePath: string): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, 'i');
    } catch (error) {
      failCodebook(filePath, `${field} 中的正则 “${pattern}” 无法编译`, error);
    }
  }
}

function validateDefinition(
  value: unknown,
  index: number,
  filePath: string,
): FailureCodeDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failCodebook(filePath, `codes[${index}] 必须是对象`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(raw.code)) {
    return failCodebook(filePath, `codes[${index}].code 必须是小写英文标识`);
  }
  if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
    return failCodebook(filePath, `代码 ${raw.code} 缺少给人看的 label`);
  }
  if (!Number.isInteger(raw.priority)) {
    return failCodebook(filePath, `代码 ${raw.code} 的 priority 必须是整数`);
  }
  if (typeof raw.match !== 'object' || raw.match === null || Array.isArray(raw.match)) {
    return failCodebook(filePath, `代码 ${raw.code} 缺少 match 对象`);
  }
  const rawMatch = raw.match as Record<string, unknown>;
  const match: FailureCodeMatch = {};
  for (const field of ['failureReason', 'failureStage', 'status', 'stderr'] as const) {
    if (rawMatch[field] === undefined) continue;
    const values = stringArray(rawMatch[field], `代码 ${raw.code}.match.${field}`, filePath);
    if (field === 'failureReason' || field === 'stderr') {
      validateRegexes(values, `代码 ${raw.code}.match.${field}`, filePath);
    }
    match[field] = values;
  }
  if (Object.keys(match).length === 0) {
    return failCodebook(filePath, `代码 ${raw.code} 至少需要一条匹配规则`);
  }

  const dispositions = stringArray(
    raw.dispositions,
    `代码 ${raw.code}.dispositions`,
    filePath,
    { allowEmpty: true },
  );
  for (const disposition of dispositions) {
    if (
      !['retryable', 'not_in_denominator', 'known_issue', 'needs_human'].includes(disposition)
      && !disposition.startsWith('known_issue:')
    ) {
      return failCodebook(filePath, `代码 ${raw.code} 含不支持的处置标签 “${disposition}”`);
    }
    if (disposition.startsWith('known_issue:')) {
      try {
        new URL(disposition.slice('known_issue:'.length));
      } catch (error) {
        failCodebook(filePath, `代码 ${raw.code} 的 known_issue 链接无效`, error);
      }
    }
  }
  const issue = raw.issue;
  if (issue !== undefined) {
    if (typeof issue !== 'string') {
      return failCodebook(filePath, `代码 ${raw.code}.issue 必须是 URL`);
    }
    try {
      const url = new URL(issue);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https');
    } catch (error) {
      failCodebook(filePath, `代码 ${raw.code}.issue 不是有效的 http/https URL`, error);
    }
  }
  if (raw.note !== undefined && typeof raw.note !== 'string') {
    return failCodebook(filePath, `代码 ${raw.code}.note 必须是字符串`);
  }
  if (dispositions.includes('known_issue') && !issue) {
    return failCodebook(filePath, `代码 ${raw.code} 使用 known_issue 时必须填写 issue URL`);
  }

  return {
    code: raw.code,
    label: raw.label,
    priority: raw.priority as number,
    match,
    dispositions: dispositions.filter((disposition) => disposition !== 'known_issue'),
    ...(issue ? { issue } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  };
}

export function loadFailureCodebook(dir: string): FailureCodebook {
  const filePath = path.basename(dir) === FAILURE_CODEBOOK_FILE
    ? dir
    : path.join(dir, FAILURE_CODEBOOK_FILE);
  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    failCodebook(filePath, '文件读取或 YAML 解析失败', error);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failCodebook(filePath, '根节点必须是对象');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1) return failCodebook(filePath, 'version 必须是 1');
  if (!Array.isArray(raw.codes) || raw.codes.length === 0) {
    return failCodebook(filePath, 'codes 必须是非空数组');
  }
  const codes = raw.codes.map((value, index) => validateDefinition(value, index, filePath));
  const seenCodes = new Set<string>();
  const seenPriorities = new Set<number>();
  for (const definition of codes) {
    if (seenCodes.has(definition.code)) {
      return failCodebook(filePath, `code “${definition.code}” 重复`);
    }
    if (seenPriorities.has(definition.priority)) {
      return failCodebook(filePath, `priority ${definition.priority} 重复`);
    }
    seenCodes.add(definition.code);
    seenPriorities.add(definition.priority);
  }
  return { version: 1, codes };
}

export function loadProjectFailureCodebookWithSource(
  projectDir = process.cwd(),
): LoadedProjectFailureCodebook {
  const projectCodebookDir = path.join(projectDir, '.claude');
  const projectCodebookPath = path.join(projectCodebookDir, FAILURE_CODEBOOK_FILE);
  if (existsSync(projectCodebookPath)) {
    return { codebook: loadFailureCodebook(projectCodebookDir), source: 'project' };
  }
  console.warn(`未找到项目失败原因码本 ${projectCodebookPath}，本轮使用内置码本。`);
  return { codebook: loadFailureCodebook(PACKAGED_FAILURE_CODEBOOK_DIR), source: 'bundled' };
}

export function loadProjectFailureCodebook(projectDir = process.cwd()): FailureCodebook {
  return loadProjectFailureCodebookWithSource(projectDir).codebook;
}

function regexMatches(patterns: string[] | undefined, values: string[]): boolean {
  return Boolean(patterns?.some((pattern) => {
    const regex = new RegExp(pattern, 'i');
    return values.some((value) => regex.test(value));
  }));
}

function matchesDefinition(
  input: FailureClassificationInput,
  definition: FailureCodeDefinition,
  stderrLines: string[],
): boolean {
  const { match } = definition;
  return (
    regexMatches(match.failureReason, input.failureReason ? [input.failureReason] : [])
    || Boolean(input.failureStage && match.failureStage?.includes(input.failureStage))
    || Boolean(input.status && match.status?.includes(input.status))
    || regexMatches(match.stderr, stderrLines)
  );
}

function normalizeStderr(stderr: FailureClassificationInput['stderr']): string[] {
  const lines = Array.isArray(stderr)
    ? stderr.flatMap((entry) => entry.split(/\r?\n/))
    : typeof stderr === 'string'
      ? stderr.split(/\r?\n/)
      : [];
  return lines.slice(-STDERR_TAIL_LINES).filter(Boolean);
}

function addFixedDispositions(
  input: FailureClassificationInput,
  stderrLines: string[],
  dispositions: Set<string>,
): void {
  if (input.failureStage === 'infra' || input.failureStage === 'cost_limit') {
    dispositions.add('not_in_denominator');
  }
  const errorText = [input.failureReason, ...stderrLines].filter(Boolean).join('\n');
  if (
    errorText
    && (
      isTransientError(errorText)
      || /fetch failed|request timeout after \d+ms|ECONN(?:REFUSED|RESET)|ENOTFOUND|socket hang up/i.test(errorText)
    )
  ) {
    dispositions.add('retryable');
  }
  if (input.failureStage === 'configuration') dispositions.add('needs_human');
}

export function classifyFailure(
  input: FailureClassificationInput,
  codebook: FailureCodebook,
): FailureClassification {
  const stderrLines = normalizeStderr(input.stderr);
  const matchedDefinitions = codebook.codes
    .filter((definition) => matchesDefinition(input, definition, stderrLines))
    .sort((left, right) => right.priority - left.priority);
  const dispositions = new Set<string>();
  for (const definition of matchedDefinitions) {
    for (const disposition of definition.dispositions) dispositions.add(disposition);
    if (definition.issue) dispositions.add(`known_issue:${definition.issue}`);
  }
  addFixedDispositions(input, stderrLines, dispositions);
  return {
    primaryFailureCode: matchedDefinitions[0]?.code ?? 'unknown',
    dispositions: [...dispositions].sort(),
    matched: matchedDefinitions.map((definition) => definition.code),
  };
}

export function assertFailureDispositionConsistency(
  status: string | undefined,
  dispositions: readonly string[],
): void {
  const excludedStatus = status === 'infra_excluded' || status === 'cost_exceeded';
  const excludedDisposition = dispositions.includes('not_in_denominator');
  if (excludedStatus !== excludedDisposition) {
    throw new Error(
      `失败处置与统计状态不一致：status=${status ?? 'unknown'}，`
      + `not_in_denominator=${excludedDisposition ? '有' : '无'}`,
    );
  }
}

export function failureCodeLabel(codebook: FailureCodebook, code: string): string {
  if (code === 'unknown') return '未归类';
  return codebook.codes.find((definition) => definition.code === code)?.label ?? code;
}
