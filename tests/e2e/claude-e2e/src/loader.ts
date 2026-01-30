import { join } from 'path';
import { readdir } from 'fs/promises';
import { TestCase } from './types.js';
import { expandExpectedBehavior } from './utils/behavior-to-validations.js';

const TEST_CASES_DIR = join(import.meta.dirname, '../test-cases');

export async function loadTestCases(): Promise<TestCase[]> {
  const categories = await readdir(TEST_CASES_DIR);
  const allCases: TestCase[] = [];

  for (const category of categories) {
    if (category.startsWith('_') || category.startsWith('.')) continue;

    const categoryDir = join(TEST_CASES_DIR, category);

    try {
      const files = await readdir(categoryDir);

      for (const file of files) {
        if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;

        const modulePath = join(categoryDir, file);
        try {
          const module = await import(modulePath);
          const testCase = module.default || Object.values(module)[0];

          if (testCase && testCase.id) {
            testCase.processValidations = expandExpectedBehavior(testCase);
            allCases.push(testCase as TestCase);
          }
        } catch (err) {
          console.warn(`Failed to load test case from ${file}:`, err);
        }
      }
    } catch {
      // 目录不存在或无法读取，跳过
    }
  }

  return allCases.sort((a, b) => a.id.localeCompare(b.id));
}
