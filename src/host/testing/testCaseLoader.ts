// ============================================================================
// Test Case Loader - Load test cases from YAML files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import * as yaml from 'js-yaml';
import type { TestSuite, TestCase } from './types';
import { resolveCaseLayer } from './caseLayer';
import { isCaseHardened } from './caseHardening';
import { findRepositoryRoot, resolveAnswerSideFile } from './answerSide';

interface AnswerCase {
  id: string;
  expect?: TestCase['expect'];
  expectations?: TestCase['expectations'];
}

interface AnswerFile {
  version: 1;
  source: string;
  cases: AnswerCase[];
}

/**
 * Parse YAML content using js-yaml
 */
function parseYaml(content: string): unknown {
  return yaml.load(content);
}

function hasNonEmptyAnswer(testCase: Pick<TestCase, 'expect' | 'expectations'>): boolean {
  return Object.keys(testCase.expect ?? {}).length > 0 || (testCase.expectations?.length ?? 0) > 0;
}

async function mergeAnswerSide(data: unknown, filePath: string): Promise<unknown> {
  const suite = data as Record<string, unknown>;
  if (!Array.isArray(suite.cases)) return data;
  const resolved = resolveAnswerSideFile(filePath);
  const repoRoot = findRepositoryRoot(filePath);
  const repoRelative = repoRoot
    ? path.relative(repoRoot, path.resolve(filePath)).split(path.sep).join('/')
    : null;
  const isPublicCaseBankFile = repoRelative?.startsWith('.claude/test-cases/') === true;
  if (!resolved && !isPublicCaseBankFile) return data;

  let answerFile: AnswerFile | null = null;
  if (resolved) {
    try {
      answerFile = parseYaml(await fs.readFile(resolved.answerFile, 'utf8')) as AnswerFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  if (answerFile && resolved) {
    if (answerFile.version !== 1 || answerFile.source !== resolved.source || !Array.isArray(answerFile.cases)) {
      throw new Error(`答案文件结构无效: ${resolved.answerFile}（source 应为 ${resolved.source}）`);
    }
    const duplicateIds = answerFile.cases
      .map((item) => item.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      throw new Error(`答案文件存在重复 id: ${resolved.answerFile}（${[...new Set(duplicateIds)].join(', ')}）`);
    }
  }
  const answersById = new Map((answerFile?.cases ?? []).map((item) => [item.id, item]));

  for (const rawCase of suite.cases) {
    const testCase = rawCase as Record<string, unknown>;
    const id = typeof testCase.id === 'string' ? testCase.id : '';
    const answer = answersById.get(id);
    if (answer && resolved && hasNonEmptyAnswer(testCase as unknown as Pick<TestCase, 'expect' | 'expectations'>)) {
      throw new Error(
        `Test case ${id}: 内联答案与答案侧同时存在（二义）: ${filePath} / ${resolved.answerFile}`,
      );
    }
    if (answer) {
      if (answer.expect !== undefined) testCase.expect = answer.expect;
      if (answer.expectations !== undefined) testCase.expectations = answer.expectations;
    } else if (!hasNonEmptyAnswer(testCase as unknown as Pick<TestCase, 'expect' | 'expectations'>)) {
      testCase.answerSide = 'missing';
      testCase.answerSidePath = resolved?.answerFile ?? `answers/${repoRelative ?? path.basename(filePath)}`;
      testCase.answerSideRoot = resolved?.answerRoot ?? '未解析到私档';
    }
  }
  return data;
}

/**
 * Validate a test case
 */
function validateTestCase(testCase: unknown, index: number, requireHardened: boolean): TestCase {
  const tc = testCase as Record<string, unknown>;

  if (!tc.id || typeof tc.id !== 'string') {
    throw new Error(`Test case ${index}: missing or invalid 'id'`);
  }

  if (!tc.type || typeof tc.type !== 'string') {
    throw new Error(`Test case ${tc.id}: missing or invalid 'type'`);
  }

  if (!tc.prompt || typeof tc.prompt !== 'string') {
    throw new Error(`Test case ${tc.id}: missing or invalid 'prompt'`);
  }

  if (!tc.description) {
    tc.description = tc.id;
  }

  tc.expect ??= {};

  if (requireHardened) {
    const hardening = isCaseHardened(tc as unknown as Pick<TestCase, 'expect' | 'expectations' | 'reviewStatus' | 'answerSide'>);
    if (!hardening.hardened && hardening.reason !== 'answer_side_missing') {
      throw new Error(`Test case ${tc.id}: 还没有判定标准（${hardening.reason}）`);
    }
  }
  if (
    tc.max_cost_usd !== undefined
    && (
      typeof tc.max_cost_usd !== 'number'
      || !Number.isFinite(tc.max_cost_usd)
      || tc.max_cost_usd <= 0
    )
  ) {
    throw new Error(`Test case ${tc.id}: 'max_cost_usd' must be a finite number greater than 0`);
  }

  return tc as unknown as TestCase;
}

/**
 * Validate a test suite
 */
function validateTestSuite(data: unknown, filePath: string, requireHardened: boolean): TestSuite {
  const suite = data as Record<string, unknown>;

  if (!suite.name || typeof suite.name !== 'string') {
    throw new Error(`Test suite in ${filePath}: missing or invalid 'name'`);
  }

  if (!Array.isArray(suite.cases)) {
    throw new Error(`Test suite in ${filePath}: missing or invalid 'cases' array`);
  }

  const suiteTags = suite.tags as string[] | undefined;
  const relativeDir = path.basename(path.dirname(filePath));
  const validatedCases = suite.cases.map((tc, i) => ({
    ...validateTestCase(tc, i, requireHardened),
    inheritedTags: suiteTags ? [...suiteTags] : undefined,
    layer: resolveCaseLayer(path.basename(filePath), relativeDir),
  }));

  return {
    name: suite.name,
    description: suite.description as string | undefined,
    cases: validatedCases,
    default_timeout: suite.default_timeout as number | undefined,
    setup: suite.setup as string[] | undefined,
    cleanup: suite.cleanup as string[] | undefined,
    tags: suite.tags as string[] | undefined,
    default_max_cost_usd: suite.default_max_cost_usd as number | undefined,
  };
}

/**
 * Load a single test suite from a YAML file
 */
export async function loadTestSuite(
  filePath: string,
  options: { requireHardened?: boolean } = {},
): Promise<TestSuite> {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = await mergeAnswerSide(parseYaml(content), filePath);
  return validateTestSuite(data, filePath, options.requireHardened !== false);
}

/**
 * Load all test suites from a directory
 */
export async function loadAllTestSuites(dir: string): Promise<TestSuite[]> {
  const suites: TestSuite[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        const filePath = path.join(dir, entry.name);
        try {
          const suite = await loadTestSuite(filePath);
          suites.push(suite);
        } catch (error) {
          console.error(`Failed to load test suite ${filePath}:`, error);
        }
      }
    }
  } catch {
    // Directory doesn't exist
    console.warn(`Test case directory not found: ${dir}`);
  }

  return suites;
}

/**
 * Filter test cases by tags and IDs
 */
export function filterTestCases(
  suites: TestSuite[],
  options: {
    filterTags?: string[];
    filterIds?: string[];
    includeOnly?: boolean;
    includeRetired?: boolean;
    today?: string;
    retiredSkipped?: string[];
  }
): TestCase[] {
  const {
    filterTags,
    filterIds,
    includeOnly,
    includeRetired = false,
    retiredSkipped,
  } = options;
  const today = options.today ?? process.env.NEO_EVAL_TODAY ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`Invalid eval retirement date: ${today}`);
  }
  const allCases: TestCase[] = [];

  for (const suite of suites) {
    for (const testCase of suite.cases) {
      // Check if should skip
      if (testCase.skip && !includeOnly) continue;

      // Filter by ID
      if (filterIds && filterIds.length > 0) {
        if (!filterIds.includes(testCase.id)) continue;
      }

      // Filter by tags
      if (filterTags && filterTags.length > 0) {
        // Keep case and suite tags separate for case-bank display, while preserving
        // the pre-CASELIST selection semantics where suite tags were filterable.
        const filterableTags = [...(testCase.tags ?? []), ...(testCase.inheritedTags ?? [])];
        if (!filterTags.some((tag) => filterableTags.includes(tag))) continue;
      }

      // Check "only" flag
      if (includeOnly && !testCase.only) continue;

      const retireAfter = testCase.rotation?.retire_after;
      if (!includeRetired && retireAfter && retireAfter <= today) {
        retiredSkipped?.push(testCase.id);
        continue;
      }

      // Apply suite defaults
      if (!testCase.timeout && suite.default_timeout) {
        testCase.timeout = suite.default_timeout;
      }
      if (testCase.max_cost_usd === undefined && suite.default_max_cost_usd !== undefined) {
        if (
          typeof suite.default_max_cost_usd !== 'number'
          || !Number.isFinite(suite.default_max_cost_usd)
          || suite.default_max_cost_usd <= 0
        ) {
          throw new Error(
            `Test suite ${suite.name}: 'default_max_cost_usd' must be a finite number greater than 0`,
          );
        }
        testCase.max_cost_usd = suite.default_max_cost_usd;
      }

      allCases.push(testCase);
    }
  }

  // If any test has "only", filter to just those
  const onlyTests = allCases.filter((tc) => tc.only);
  if (onlyTests.length > 0) {
    return onlyTests;
  }

  return allCases;
}

/**
 * Sort test cases by dependencies
 */
export function sortByDependencies(cases: TestCase[]): TestCase[] {
  const caseMap = new Map(cases.map((tc) => [tc.id, tc]));
  const sorted: TestCase[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(tc: TestCase) {
    if (visited.has(tc.id)) return;
    if (visiting.has(tc.id)) {
      throw new Error(`Circular dependency detected: ${tc.id}`);
    }

    visiting.add(tc.id);

    for (const depId of tc.depends_on || []) {
      const dep = caseMap.get(depId);
      if (dep) {
        visit(dep);
      }
    }

    visiting.delete(tc.id);
    visited.add(tc.id);
    sorted.push(tc);
  }

  for (const tc of cases) {
    visit(tc);
  }

  return sorted;
}
