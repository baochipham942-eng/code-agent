import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import type {
  EvalCaseListEntry,
  EvalCaseListItem,
  EvalCaseSplitBucket,
  SaveEvalCaseRequest,
  SaveEvalCaseResult,
} from '../../shared/contract/evaluation';
import { loadEvalSplits } from './ci/sampleSplits';
import { loadTestSuite } from './testCaseLoader';
import { resolveCaseLayer } from './caseLayer';
import type { TestCase } from './types';

const CASE_BANK_RELATIVE_PATH = path.join('.claude', 'test-cases');
const ENUMERATED_SUBDIRECTORIES = [
  'artifact-runnable',
  'goal-contract',
  'user-simulator',
  'drafts',
] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isYamlFile(fileName: string): boolean {
  return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
}

async function listYamlFiles(dir: string, recursive: boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isFile() && isYamlFile(entry.name)) {
      files.push(absolutePath);
    } else if (recursive && entry.isDirectory()) {
      files.push(...await listYamlFiles(absolutePath, true));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function caseBankYamlFiles(caseBankRoot: string): Promise<string[]> {
  const rootFiles = await listYamlFiles(caseBankRoot, false);
  const nestedFiles = await Promise.all(
    ENUMERATED_SUBDIRECTORIES.map((directory) => listYamlFiles(path.join(caseBankRoot, directory), true)),
  );
  return [...rootFiles, ...nestedFiles.flat()];
}

function relativeCaseFile(caseBankRoot: string, filePath: string): string {
  return path.relative(caseBankRoot, filePath).split(path.sep).join('/');
}

function splitIndex(splitFile: Awaited<ReturnType<typeof loadEvalSplits>>): Map<string, EvalCaseSplitBucket[]> {
  const index = new Map<string, EvalCaseSplitBucket[]>();
  if (!splitFile) return index;
  const buckets: Array<[EvalCaseSplitBucket, string[]]> = [
    ['held-in', splitFile.heldIn],
    ['held-out', splitFile.heldOut],
    ['control', splitFile.control],
    ['safety', splitFile.safety],
  ];
  for (const [bucket, ids] of buckets) {
    for (const id of ids) index.set(id, [...(index.get(id) ?? []), bucket]);
  }
  return index;
}

function expectationExists(testCase: TestCase): boolean {
  return Object.keys(testCase.expect ?? {}).length > 0 || (testCase.expectations?.length ?? 0) > 0;
}

function caseTurns(testCase: TestCase): number | 'simulator' {
  if (testCase.user_simulation) return 'simulator';
  return 1 + (testCase.follow_up_prompts?.length ?? 0);
}

function isRetired(testCase: TestCase, today: string): boolean {
  const retireAfter = testCase.rotation?.retire_after;
  return Boolean(retireAfter && retireAfter <= today);
}

function humanParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n')[0].trim();
  return firstLine || 'YAML 无法读取';
}

/** Enumerate the visible case bank without changing the default non-recursive runner loader. */
export async function enumerateCaseBank(repoRoot: string, today = todayIso()): Promise<EvalCaseListItem[]> {
  const caseBankRoot = path.join(repoRoot, CASE_BANK_RELATIVE_PATH);
  const [files, splitFile] = await Promise.all([
    caseBankYamlFiles(caseBankRoot),
    loadEvalSplits(repoRoot),
  ]);
  const splitsById = splitIndex(splitFile);
  const items: EvalCaseListItem[] = [];

  for (const filePath of files) {
    const file = relativeCaseFile(caseBankRoot, filePath);
    const relativeDir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    const isDraft = relativeDir === 'drafts' || relativeDir.startsWith('drafts/');
    try {
      const suite = await loadTestSuite(filePath);
      for (const testCase of suite.cases) {
        const item: EvalCaseListEntry = {
          id: testCase.id,
          file,
          relativeDir,
          layer: resolveCaseLayer(file, relativeDir),
          tags: [...(testCase.tags ?? [])],
          inheritedTags: [...(testCase.inheritedTags ?? [])],
          splits: [...(splitsById.get(testCase.id) ?? [])],
          turns: caseTurns(testCase),
          hasExpect: expectationExists(testCase),
          reviewStatus: testCase.reviewStatus,
          source: testCase.sourceSessionId ? 'session' : 'manual',
          retired: isRetired(testCase, today),
          isDraft,
        };
        items.push(item);
      }
    } catch (error) {
      items.push({
        id: path.basename(file),
        file,
        relativeDir,
        parseError: humanParseError(error),
        isDraft,
      });
    }
  }

  return items;
}

function assertSafeDraftId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error('题目 id 只能包含字母、数字、短横线和下划线');
  }
}

function assertInsideCaseBank(caseBankRoot: string, targetPath: string): void {
  const relative = path.relative(caseBankRoot, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('写入路径必须位于题库目录内');
  }
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('标签必须是字符串数组');
  }
  const stringTags = tags.filter((tag): tag is string => typeof tag === 'string');
  return [...new Set(stringTags.map((tag) => tag.trim()).filter(Boolean))];
}

async function createDraft(
  caseBankRoot: string,
  request: Extract<SaveEvalCaseRequest, { action: 'create-draft' }>,
  today: string,
): Promise<SaveEvalCaseResult> {
  const id = request.id.trim();
  const prompt = request.prompt.trim();
  assertSafeDraftId(id);
  if (!prompt) throw new Error('题目输入不能为空');
  const tags = normalizeTags(request.tags);
  for (const filePath of await caseBankYamlFiles(caseBankRoot)) {
    try {
      const suite = await loadTestSuite(filePath);
      if (suite.cases.some((testCase) => testCase.id === id)) {
        throw new Error(`题目 id「${id}」已存在`);
      }
    } catch (error) {
      if (error instanceof Error && error.message === `题目 id「${id}」已存在`) throw error;
      // A broken unrelated YAML remains visible as a parse-error row and must not block drafts.
    }
  }
  const draftsDir = path.join(caseBankRoot, 'drafts');
  const targetPath = path.join(draftsDir, `${id}.yaml`);
  assertInsideCaseBank(caseBankRoot, targetPath);
  await fs.mkdir(draftsDir, { recursive: true });

  const document = new Document({
    name: `${id} draft`,
    cases: [{
      id,
      type: 'task',
      description: prompt,
      prompt,
      ...(tags.length > 0 ? { tags } : {}),
      reviewStatus: 'pending',
      expect: {},
      rotation: { introduced: today },
    }],
  });
  try {
    await fs.writeFile(targetPath, document.toString({ lineWidth: 0 }), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`题目 id「${id}」已存在`, { cause: error });
    }
    throw error;
  }
  return { action: request.action, id, file: relativeCaseFile(caseBankRoot, targetPath) };
}

async function archiveCase(
  caseBankRoot: string,
  id: string,
  today: string,
): Promise<SaveEvalCaseResult> {
  if (!id.trim()) throw new Error('题目 id 不能为空');
  const files = await caseBankYamlFiles(caseBankRoot);
  const matches: Array<{
    filePath: string;
    source: string;
    caseNode: unknown;
  }> = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    const document = parseDocument(source);
    if (document.errors.length > 0) continue;
    const cases = document.get('cases', true);
    if (!isSeq(cases)) continue;
    for (const caseNode of cases.items) {
      if (isMap(caseNode) && caseNode.get('id') === id) matches.push({ filePath, source, caseNode });
    }
  }

  if (matches.length === 0) throw new Error(`找不到题目「${id}」`);
  if (matches.length > 1) throw new Error(`题目 id「${id}」不唯一，无法归档`);
  const [{ filePath, source, caseNode }] = matches;
  assertInsideCaseBank(caseBankRoot, filePath);
  if (!isMap(caseNode)) throw new Error(`题目「${id}」结构不正确`);
  const rotation = caseNode.get('rotation', true);
  let updatedSource: string;
  if (rotation === undefined || rotation === null) {
    const insertionPoint = caseNode.range?.[1];
    if (insertionPoint === undefined) throw new Error(`题目「${id}」缺少可编辑的源码位置`);
    updatedSource = `${source.slice(0, insertionPoint)}    rotation:\n      retire_after: ${today}\n${source.slice(insertionPoint)}`;
  } else if (isMap(rotation)) {
    const existingRetireAfter = rotation.get('retire_after', true);
    if (existingRetireAfter?.range) {
      const [start, end] = existingRetireAfter.range;
      updatedSource = `${source.slice(0, start)}${today}${source.slice(end)}`;
    } else {
      const insertionPoint = rotation.range?.[1];
      if (insertionPoint === undefined || rotation.flow) {
        throw new Error(`题目「${id}」的 rotation 需要使用分行 YAML 结构`);
      }
      updatedSource = `${source.slice(0, insertionPoint)}      retire_after: ${today}\n${source.slice(insertionPoint)}`;
    }
  } else {
    throw new Error(`题目「${id}」的 rotation 结构不正确`);
  }
  await fs.writeFile(filePath, updatedSource, 'utf8');
  return { action: 'archive', id, file: relativeCaseFile(caseBankRoot, filePath) };
}

export async function saveCaseBank(
  repoRoot: string,
  request: SaveEvalCaseRequest,
  today = todayIso(),
): Promise<SaveEvalCaseResult> {
  const caseBankRoot = path.join(repoRoot, CASE_BANK_RELATIVE_PATH);
  if (!request || typeof request !== 'object') throw new Error('题库操作参数无效');
  if (request.action === 'create-draft') return createDraft(caseBankRoot, request, today);
  if (request.action === 'archive') return archiveCase(caseBankRoot, request.id, today);
  throw new Error('不支持的题库操作');
}
