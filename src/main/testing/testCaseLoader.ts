// ============================================================================
// Test Case Loader - Load test cases from YAML files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { TestSuite, TestCase } from './types';

/**
 * Simple YAML parser for test cases
 * Supports basic YAML features needed for test definitions
 */
function parseYaml(content: string): unknown {
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown>; key?: string; isArray?: boolean }[] = [
    { indent: -1, obj: result },
  ];

  let currentArray: unknown[] | null = null;
  let currentArrayKey: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Calculate indentation
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack until we find parent with less indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];

    // Array item
    if (trimmed.startsWith('- ')) {
      const itemContent = trimmed.slice(2).trim();

      // Initialize array if needed
      if (!currentArray || currentArrayKey !== parent.key) {
        currentArray = [];
        currentArrayKey = parent.key || null;
        if (parent.key) {
          parent.obj[parent.key] = currentArray;
        }
      }

      // Check if it's an object item (has colon)
      if (itemContent.includes(':')) {
        const newObj: Record<string, unknown> = {};
        currentArray.push(newObj);

        // Parse the first key-value pair
        const colonIdx = itemContent.indexOf(':');
        const key = itemContent.slice(0, colonIdx).trim();
        const value = itemContent.slice(colonIdx + 1).trim();

        if (value) {
          newObj[key] = parseValue(value);
        }

        stack.push({ indent, obj: newObj, isArray: false });
      } else {
        // Simple array item
        currentArray.push(parseValue(itemContent));
      }
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const valueStr = trimmed.slice(colonIdx + 1).trim();

      // Reset array tracking when we see a new key
      if (currentArrayKey !== key) {
        currentArray = null;
        currentArrayKey = null;
      }

      if (valueStr === '' || valueStr === '|' || valueStr === '>') {
        // Object or multiline string - will be filled by children
        const newObj: Record<string, unknown> = {};
        parent.obj[key] = newObj;
        stack.push({ indent, obj: newObj, key });
      } else {
        // Simple value
        parent.obj[key] = parseValue(valueStr);
      }
    }
  }

  return result;
}

/**
 * Parse a YAML value string
 */
function parseValue(str: string): unknown {
  // Remove quotes
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }

  // Boolean
  if (str === 'true') return true;
  if (str === 'false') return false;

  // Null
  if (str === 'null' || str === '~') return null;

  // Number
  const num = Number(str);
  if (!isNaN(num) && str !== '') return num;

  // Array shorthand [a, b, c]
  if (str.startsWith('[') && str.endsWith(']')) {
    const inner = str.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(',').map((s) => parseValue(s.trim()));
  }

  // String
  return str;
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

      // Filter by tags
      if (filterTags && filterTags.length > 0) {
        const caseTags = testCase.tags || [];
        const suiteTags = suite.tags || [];
        const allTags = [...caseTags, ...suiteTags];
        if (!filterTags.some((tag) => allTags.includes(tag))) continue;
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
