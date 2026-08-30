import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  filterTestCases,
  loadAllTestSuites,
} from '../../src/host/testing/testCaseLoader';
import type { TestCase } from '../../src/host/testing/types';

export interface InspectDatasetRecord {
  id: string;
  input: string;
  target: string;
  metadata: {
    case: TestCase;
  };
}

const FILE_EXPECTATIONS = new Set([
  'artifact_runnable',
  'content_contains',
  'content_not_contains',
  'file_exists',
  'file_not_exists',
  'game_smoke',
  'html_renders',
  'pptx_opens',
  'test_pass',
]);

export function inspectTextCaseRejection(testCase: TestCase): string | undefined {
  if (testCase.setup?.length || testCase.cleanup?.length || testCase.files?.length) {
    return 'has setup, cleanup, or file injection';
  }
  if (testCase.follow_up_prompts?.length || testCase.user_simulation || testCase.goal_contract) {
    return 'is multi-turn or goal-driven';
  }
  const legacyFileKeys = [
    testCase.expect?.files_created,
    testCase.expect?.files_modified,
    testCase.expect?.file_contains,
    testCase.expect?.files_not_exist,
    testCase.expect?.file_exists,
    testCase.expect?.file_not_contains,
    testCase.expect?.test_pass,
  ];
  if (legacyFileKeys.some(Boolean)) return 'has filesystem assertions';
  if (testCase.expectations?.some((expectation) => FILE_EXPECTATIONS.has(expectation.type))) {
    return 'has filesystem expectations';
  }
  return undefined;
}

export async function exportInspectDataset(options: {
  caseDir: string;
  ids: string[];
}): Promise<InspectDatasetRecord[]> {
  if (options.ids.length === 0) throw new Error('At least one case id is required');
  const duplicateIds = options.ids.filter((id, index) => options.ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate case ids: ${Array.from(new Set(duplicateIds)).join(', ')}`);
  }

  const suites = await loadAllTestSuites(options.caseDir);
  const selected = filterTestCases(suites, { filterIds: options.ids });
  const byId = new Map(selected.map((testCase) => [testCase.id, testCase]));
  const missing = options.ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Unknown or skipped case ids: ${missing.join(', ')}`);

  return options.ids.map((id) => {
    const testCase = byId.get(id)!;
    const rejection = inspectTextCaseRejection(testCase);
    if (rejection) throw new Error(`Case ${id} is not a pure-text Inspect case: ${rejection}`);
    return {
      id,
      input: testCase.prompt,
      target: id,
      metadata: { case: testCase },
    };
  });
}

interface CliOptions {
  caseDir: string;
  idsFile: string;
  output: string;
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) throw new Error(`Invalid argument near ${flag ?? '<end>'}`);
    values.set(flag, value);
  }
  const root = process.cwd();
  return {
    caseDir: path.resolve(values.get('--case-dir') ?? path.join(root, '.claude', 'test-cases')),
    idsFile: path.resolve(values.get('--ids-file') ?? path.join(root, 'scripts', 'inspect', 'five-case.ids')),
    output: path.resolve(values.get('--output') ?? path.join(root, '.code-agent', 'inspect', 'five-case.jsonl')),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ids = (await fs.readFile(options.idsFile, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const records = await exportInspectDataset({ caseDir: options.caseDir, ids });
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  process.stdout.write(`${options.output}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
