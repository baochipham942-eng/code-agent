// ============================================================================
// Test Case Loader - Load test cases from YAML files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type { TestSuite, TestCase } from './types';

/**
 * Parse YAML content using js-yaml
 */
function parseYaml(content: string): unknown {
  return yaml.load(content);
}

/**
 * Validate a test case
 */
function validateTestCase(testCase: unknown, index: number): TestCase {
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

  if (!tc.expect) {
    tc.expect = {};
  }

  return tc as unknown as TestCase;
}

/**
 * Validate a test suite
 */
function validateTestSuite(data: unknown, filePath: string): TestSuite {
  const suite = data as Record<string, unknown>;

  if (!suite.name || typeof suite.name !== 'string') {
    throw new Error(`Test suite in ${filePath}: missing or invalid 'name'`);
  }

  if (!Array.isArray(suite.cases)) {
    throw new Error(`Test suite in ${filePath}: missing or invalid 'cases' array`);
  }

  const validatedCases = suite.cases.map((tc, i) => validateTestCase(tc, i));

  return {
    name: suite.name,
    description: suite.description as string | undefined,
    cases: validatedCases,
    default_timeout: suite.default_timeout as number | undefined,
    setup: suite.setup as string[] | undefined,
    cleanup: suite.cleanup as string[] | undefined,
    tags: suite.tags as string[] | undefined,
  };
}

/**
 * Load a single test suite from a YAML file
 */
export async function loadTestSuite(filePath: string): Promise<TestSuite> {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = parseYaml(content);
  return validateTestSuite(data, filePath);
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
  } catch (error) {
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
  }
): TestCase[] {
  const { filterTags, filterIds, includeOnly } = options;
  const allCases: TestCase[] = [];

  for (const suite of suites) {
    for (const testCase of suite.cases) {
      // Check if should skip
      if (testCase.skip && !includeOnly) continue;

      // Filter by ID
      if (filterIds && filterIds.length > 0) {
        if (!filterIds.includes(testCase.id)) continue;
      }

      // ADR-036 F3 根因修复：suite 级 tags（YAML 顶层 tags:）合并进 case.tags，
      // 落到 testCase 对象上而不只是本函数内部临时算一次——否则只靠 suite 级
      // tags 标红线/security 的 case 会被 testRunner.isRedlineCase（只读
      // case.tags/category，看不到 suite 级 tags）漏判。真实复现：
      // .claude/test-cases/06-security-redline-tests.yaml 里 12 个 security-*
      // case 仅 1 个显式写了 case 级 category: security，其余 11 个（含
      // security-prompt-injection-indirect，即错题本记录的"删 node_modules"
      // 注入 case 原型）全靠 suite 级 tags: [security, redline]，红线闸此前
      // 对它们形同虚设。合并一次，所有下游消费者都能看到完整标签。
      if (suite.tags && suite.tags.length > 0) {
        testCase.tags = Array.from(new Set([...(testCase.tags || []), ...suite.tags]));
      }

      // Filter by tags
      if (filterTags && filterTags.length > 0) {
        if (!filterTags.some((tag) => (testCase.tags || []).includes(tag))) continue;
      }

      // Check "only" flag
      if (includeOnly && !testCase.only) continue;

      // Apply suite defaults
      if (!testCase.timeout && suite.default_timeout) {
        testCase.timeout = suite.default_timeout;
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
