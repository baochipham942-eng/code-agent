import fs from 'fs/promises';
import path from 'path';
import type { ToolExecutionRecord } from './types';

interface MockFixtureResult {
  responses: string[];
  toolExecutions: ToolExecutionRecord[];
  turnCount: number;
  errors: string[];
}

interface MockFixturePolicy {
  kind: 'fixture';
  reason: string;
  run(workingDirectory: string): Promise<MockFixtureResult>;
}

interface MockRealOnlyPolicy {
  kind: 'real-only';
  reason: string;
}

export type MockCasePolicy = MockFixturePolicy | MockRealOnlyPolicy;

function execution(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  success = true,
  error?: string,
): ToolExecutionRecord {
  return {
    tool,
    input,
    output,
    success,
    ...(error ? { error } : {}),
    duration: 1,
    timestamp: Date.now(),
  };
}

function result(
  responses: string[],
  toolExecutions: ToolExecutionRecord[],
  errors: string[] = [],
): MockFixtureResult {
  return { responses, toolExecutions, turnCount: 1, errors };
}

async function writeFixture(
  workingDirectory: string,
  relativePath: string,
  content: string,
  response = `Created ${relativePath}`,
): Promise<MockFixtureResult> {
  const target = path.join(workingDirectory, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return result(
    [response],
    [execution('Write', { file_path: target, content }, `Wrote ${content.length} bytes to ${relativePath}`)],
  );
}

async function replaceFixture(
  workingDirectory: string,
  relativePath: string,
  replacements: Array<[string, string]>,
): Promise<MockFixtureResult> {
  const target = path.join(workingDirectory, relativePath);
  const before = await fs.readFile(target, 'utf8');
  const after = replacements.reduce(
    (content, [oldText, newText]) => content.replace(oldText, newText),
    before,
  );
  await fs.writeFile(target, after, 'utf8');
  return result(
    [`Updated ${relativePath}`],
    [
      execution('Read', { file_path: target }, before),
      execution('Edit', { file_path: target, replacements }, `Updated ${relativePath}`),
    ],
  );
}

const fixtureReason = '确定性 mock fixture 可独立产生文件/工具协议形态，由现有断言器验证';

const FIXTURES: Record<string, MockFixturePolicy['run']> = {
  'bash-pwd': async (workingDirectory) => result(
    [workingDirectory],
    [execution('bash', { command: 'pwd' }, workingDirectory)],
  ),
  'bash-echo': async () => result(
    ['Hello Test'],
    [execution('bash', { command: 'echo "Hello Test"' }, 'Hello Test')],
  ),
  'read-file-not-exists': async (workingDirectory) => {
    const target = path.join(workingDirectory, 'this-file-does-not-exist-12345.txt');
    return result(
      ['The requested file does not exist.'],
      [execution('Read', { file_path: target }, '', false, 'ENOENT: no such file')],
    );
  },
  'write-file-new': (workingDirectory) => writeFixture(
    workingDirectory,
    'test-write-temp.txt',
    'Test content 123\n',
  ),
  'edit-file-modify': (workingDirectory) => replaceFixture(
    workingDirectory,
    'test-edit-temp.txt',
    [['OLD', 'NEW']],
  ),
  'task-create-json-config': (workingDirectory) => writeFixture(
    workingDirectory,
    'test-config.json',
    JSON.stringify({ name: 'mock-app', version: '1.0.0', enabled: true }, null, 2),
  ),
  'error-recovery-retry': async (workingDirectory) => {
    const target = path.join(workingDirectory, 'nonexistent.txt');
    await fs.writeFile(target, 'Created after error\n', 'utf8');
    return result(
      ['The missing file was not found, so it was created after the error.'],
      [
        execution('Read', { file_path: target }, '', false, 'ENOENT: no such file'),
        execution('Write', { file_path: target, content: 'Created after error' }, 'Created nonexistent.txt'),
      ],
    );
  },
  'codegen-typescript': (workingDirectory) => writeFixture(
    workingDirectory,
    'test-stack.ts',
    'export class Stack<T> {\n  private items: T[] = [];\n  push(value: T) { this.items.push(value); }\n  pop() { return this.items.pop(); }\n  peek() { return this.items.at(-1); }\n  isEmpty() { return this.items.length === 0; }\n}\n',
  ),
  'data-cleaning': async (workingDirectory) => {
    const target = path.join(workingDirectory, 'test-clean-data.csv');
    const content = 'name,age,score\nAlice,25,88\nEve,22,91\n';
    await fs.writeFile(target, content, 'utf8');
    return result(
      ['Removed rows with missing or out-of-range values.'],
      [
        execution('Read', { file_path: path.join(workingDirectory, 'test-dirty-data.csv') }, 'dirty csv'),
        execution('Write', { file_path: target, content }, 'Wrote test-clean-data.csv'),
      ],
    );
  },
  'workflow-multi-file': async (workingDirectory) => {
    const typesPath = path.join(workingDirectory, 'test-multifile/types.ts');
    const servicePath = path.join(workingDirectory, 'test-multifile/service.ts');
    const utilsPath = path.join(workingDirectory, 'test-multifile/utils.ts');
    const typesBefore = await fs.readFile(typesPath, 'utf8');
    const serviceBefore = await fs.readFile(servicePath, 'utf8');
    await fs.writeFile(typesPath, typesBefore.replace('email: string;', 'email: string;\n  role: string;'), 'utf8');
    await fs.writeFile(servicePath, serviceBefore.replace("email: 'alice@example.com'", "email: 'alice@example.com', role: 'admin'"), 'utf8');
    await fs.writeFile(utilsPath, "import type { User } from './types';\nexport const isAdmin = (user: User) => user.role === 'admin';\n", 'utf8');
    return result(['Updated all three files.'], [
      execution('Read', { file_path: typesPath }, typesBefore),
      execution('Edit', { file_path: typesPath }, 'Added role'),
      execution('Edit', { file_path: servicePath }, 'Added role data'),
      execution('Write', { file_path: utilsPath }, 'Created utils.ts'),
    ]);
  },
  'git-status': async () => result(
    ['On branch main; working tree clean'],
    [execution('bash', { command: 'git -C test-git-repo status' }, 'On branch main\nnothing to commit, working tree clean')],
  ),
  'edge-unicode-filename': (workingDirectory) => writeFixture(
    workingDirectory,
    'test-中文文件.txt',
    '测试中文文件名\n',
  ),
  'multi-turn-incremental-task': (workingDirectory) => writeFixture(
    workingDirectory,
    'test-multi-step.ts',
    'export const add = (a: number, b: number): number => a + b;\nexport const multiply = (a: number, b: number): number => a * b;\n',
  ),
  'multi-turn-correction': (workingDirectory) => writeFixture(
    workingDirectory,
    'test-greeting.ts',
    "export const greet = (name: string): string => `你好，${name}`;\n",
  ),
  'prompt-smoke-write-file': (workingDirectory) => writeFixture(
    workingDirectory,
    'prompt-smoke-write.txt',
    'prompt smoke write ok',
  ),
  'prompt-smoke-edit-multiple-replacements': (workingDirectory) => replaceFixture(
    workingDirectory,
    'prompt-smoke-multi-edit.txt',
    [['alpha=old', 'alpha=new'], ['beta=old', 'beta=new']],
  ),
  'prompt-smoke-grep-current-name': async () => result(
    ['code-agent appears in package.json'],
    [execution('Grep', { pattern: 'code-agent', path: 'package.json' }, '"name": "code-agent"')],
  ),
  'prompt-smoke-toolsearch-json-arguments': async () => result(
    ['Loaded Browser tooling.'],
    [execution('ToolSearch', { query: 'browser tooling' }, 'Browser')],
  ),
  'prompt-smoke-task-single-delegate': async () => result(
    ['code-agent'],
    [execution('Task', { prompt: 'inspect package.json' }, 'code-agent')],
  ),
  'prompt-smoke-git-status-no-commit': async () => result(
    ['Changes not staged for commit.'],
    [execution('Bash', { command: 'git -C prompt-smoke-git status' }, 'Changes not staged for commit:\n modified: file.txt')],
  ),
};

export const MOCK_FIXTURE_CASE_IDS = Object.freeze(Object.keys(FIXTURES));

export const MOCK_REAL_ONLY_CASE_IDS = Object.freeze([
  'conv-ask-clarification',
  'conv-handle-ambiguous',
  'conv-understand-context',
  'conv-understand-intent',
  'cross-file-consistent-edit',
  'data-csv-basic',
  'debug-runtime-error',
  'debug-syntax-error',
  'doc-data-to-report',
  'edge-emoji-input',
  'edge-malformed-json',
  'edge-single-word',
  'error-command-failed',
  'error-directory-not-found',
  'error-file-not-found',
  'error-graceful-fallback',
  'excel-bench-46167',
  'excel-bench-55427',
  'excel-bench-59196',
  'excel-bench-66-1',
  'git-branch-create',
  'git-conflict-awareness',
  'git-diff-analysis',
  'git-log',
  'long-chain-budget-15',
  'longtext-generate-doc',
  'longtext-read-large-file',
  'longtext-scan-directory',
  'modify-verify-modify',
  'multi-turn-build-on-previous',
  'multi-turn-context-memory',
  'multi-turn-drill-down',
  'multi-turn-misunderstand-fix',
  'multiagent-cross-file-analysis',
  'multiagent-workflow-analysis',
  'ppt-from-outline',
  'prompt-smoke-read-package',
  'recovery-binary-file',
  'recovery-command-retry',
  'recovery-partial-success',
  'recovery-path-fallback',
  'recovery-tool-fallback',
  'recovery-write-readonly',
  'refactor-extract-function',
  'refactor-rename-variable',
  'reread-loop-trap',
  'task-analyze-structure',
  'task-explain-code',
  'vision-screenshot-describe',
  'web-fetch-json-api',
  'web-fetch-page',
  'web-search-basic',
  'web-search-chinese',
  'workflow-analyze-and-document',
  'workflow-e2e-improve',
  'workflow-read-modify-verify',
]);

const REAL_ONLY = new Set<string>(MOCK_REAL_ONLY_CASE_IDS);

export function getMockCasePolicy(testId: string): MockCasePolicy | undefined {
  const fixture = FIXTURES[testId];
  if (fixture) return { kind: 'fixture', reason: fixtureReason, run: fixture };
  if (!REAL_ONLY.has(testId)) return undefined;
  const reason = testId === 'prompt-smoke-read-package'
    ? '需要真实 agent 读取并回答；case 仍断言历史版本 0.16，mock 不应伪造通过'
    : '核心断言依赖真实 agent 的语义、策略或产物能力，确定性 mock 没有有效信号';
  return { kind: 'real-only', reason };
}

export function assertMockPolicyCoverage(testIds: string[]): void {
  const fixtureIds = new Set(MOCK_FIXTURE_CASE_IDS);
  const duplicates = MOCK_REAL_ONLY_CASE_IDS.filter((testId) => fixtureIds.has(testId));
  const missing = testIds.filter((testId) => !getMockCasePolicy(testId));
  const stale = [...MOCK_FIXTURE_CASE_IDS, ...MOCK_REAL_ONLY_CASE_IDS]
    .filter((testId) => !testIds.includes(testId));
  if (duplicates.length || missing.length || stale.length) {
    throw new Error(
      `mock policy 与当前 case 集不一致：`
      + `duplicates=[${duplicates.join(', ')}], missing=[${missing.join(', ')}], stale=[${stale.join(', ')}]`,
    );
  }
}
