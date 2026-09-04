import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import type {
  EvalCaseListEntry,
  EvalCaseListItem,
  EvalCaseSplitBucket,
  EvalDraftCaseType,
  HarvestCandidate,
  HarvestExpectationType,
  SaveEvalCaseRequest,
  SaveEvalCaseResult,
} from '@shared/contract/evaluation';
import {
  EVAL_DRAFT_CASE_TYPES,
  HARVEST_EXPECTATION_PARAM_KEYS,
  HARVEST_EXPECTATION_TYPES,
} from '@shared/contract/evaluation';
import { guardSensitiveText } from '@host/security/sensitiveDataGuard';
import { loadEvalSplits } from '@host/testing/ci/sampleSplits';
import { loadTestSuite } from '@host/testing/testCaseLoader';
import { resolveCaseLayer } from '@host/testing/caseLayer';
import type { ExpectationType, TestCase, TestCaseType } from '@host/testing/types';
import { expectationExists, isCaseHardened } from '@host/testing/caseHardening';

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
      const suite = await loadTestSuite(filePath, { requireHardened: false });
      for (const testCase of suite.cases) {
        const { hardened } = isCaseHardened(testCase);
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
          hardened,
          ...(testCase.answerSide ? { answerSide: testCase.answerSide } : {}),
          reviewStatus: testCase.reviewStatus,
          source: testCase.sourceSessionId ? 'session' : 'manual',
          type: testCase.type,
          ...(testCase.category ? { category: testCase.category } : {}),
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

// 契约里的白名单必须是宿主断言类型/题型的真子集——写错一个字，草稿会带着
// 永远跑不起来的断言进题库，而 YAML 本身合法、没有任何门会红。
const _harvestTypesAreRealExpectations: HarvestExpectationType extends ExpectationType ? true : never = true;
const _draftTypesAreRealCaseTypes: EvalDraftCaseType extends TestCaseType ? true : never = true;
void _harvestTypesAreRealExpectations;
void _draftTypesAreRealCaseTypes;

/**
 * 敏感内容闸：命中即拒存，无绕过。guardSensitiveText 返回脱敏后的文本，
 * 与原文不同就说明里面有需要人工处理的东西（密钥、家目录、邮箱、身份证号…）。
 * maxLength 按原文长度给，避免长题面被默认截断后误判成「命中」。
 */
function assertNotSensitive(label: string, text: string): void {
  if (!text) return;
  const guarded = guardSensitiveText(text, {
    surface: 'export',
    mode: 'share',
    maxLength: text.length + 1,
  });
  if (guarded !== text) {
    throw new Error(`${label}含敏感内容，先人工处理后再保存`);
  }
}

function normalizeExpectations(expectations: HarvestCandidate[] | undefined): HarvestCandidate[] {
  if (expectations === undefined) return [];
  if (!Array.isArray(expectations)) throw new Error('判定标准必须是数组');
  return expectations.map((expectation) => {
    if (!expectation || typeof expectation !== 'object') throw new Error('判定标准格式不正确');
    const type = expectation.type;
    if (!HARVEST_EXPECTATION_TYPES.includes(type)) {
      throw new Error(`不支持的判定标准类型「${String(type)}」`);
    }
    const allowedKeys = HARVEST_EXPECTATION_PARAM_KEYS[type];
    const params: Record<string, string> = {};
    for (const key of allowedKeys) {
      const value = (expectation.params ?? {})[key];
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`判定标准「${type}」缺少参数 ${key}`);
      }
      params[key] = value.trim();
    }
    const extra = Object.keys(expectation.params ?? {}).filter((key) => !allowedKeys.includes(key));
    if (extra.length > 0) throw new Error(`判定标准「${type}」有多余参数：${extra.join('、')}`);
    return { type, params, reason: String(expectation.reason ?? '').trim() };
  });
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
  const description = (request.description ?? prompt).trim() || prompt;
  const caseType: EvalDraftCaseType = request.type ?? 'task';
  if (!EVAL_DRAFT_CASE_TYPES.includes(caseType)) throw new Error(`不支持的题目类型「${String(caseType)}」`);
  const sourceSessionId = request.sourceSessionId?.trim();
  // 存为待办 = 明确不带判定标准，题库页照旧标「还没有判定标准」。
  const expectations = request.pending ? [] : normalizeExpectations(request.expectations);
  assertNotSensitive('题目输入', prompt);
  assertNotSensitive('题目描述', description);
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
      type: caseType,
      description,
      prompt,
      ...(tags.length > 0 ? { tags } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      // 人确认过判定标准也仍是 pending：硬化 = 人把文件移出 drafts/ 并改 reviewed。
      reviewStatus: 'pending',
      expect: {},
      ...(expectations.length > 0
        ? {
          expectations: expectations.map((expectation) => ({
            type: expectation.type,
            description: expectation.reason || expectation.type,
            params: expectation.params,
          })),
        }
        : {}),
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
