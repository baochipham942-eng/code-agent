/**
 * 记忆评测（N-EVAL-MEMORY）
 *
 * 评测默认关记忆（EVAL_AGENT_DEFAULTS.persistLongTermMemory=false，
 * runFinalizer 据此同时关掉 writeDurableFacts 与 recordSessionEnd）。
 * 只有显式声明 `memory.enabled` 的 case 才开，并且只在**每题隔离的数据目录**里开——
 * 记忆目录 = getUserConfigDir()/memory，而 getUserConfigDir() 跟 CODE_AGENT_DATA_DIR 走，
 * 所以隔离由「事件桥每题 mkdtemp 并设 CODE_AGENT_DATA_DIR」这一条既有机制承担。
 * 本模块只做四件事：
 *   1. 校验 case 的 memory 声明（enabled 才允许 seed；文件名只允许安全的 .md 名）；
 *   2. 起跑前把 seed 写进该题记忆目录并重建索引（seedCaseMemory）；
 *   3. 跑完、cleanup 之前对记忆目录做正文快照（snapshotMemoryDir）；
 *   4. 两个确定性判定 memory_recalled / memory_written 读 1、2、3 落下的证据。
 *
 * fail-loud 口径同 approvalRequestEval：没有证据源（mock adapter / 旧 adapter）时两个判定
 * 都显式红，绝不静默算过——「没记录」和「记录里没有」是两回事，混起来就是假绿。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { rebuildLightMemoryIndex, writeLightMemoryFile } from '../lightMemory/lightMemoryIpc';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import type { EvalCaseMemory, MemoryFileSnapshot, MemoryRecallRecord, TestCase } from './types';

export interface MemoryEvaluation {
  passed: boolean;
  actual: unknown;
  expected: string;
  details: string;
}

/** 记忆 seed 只允许朴素的 .md 文件名：不许目录、不许穿越、不许隐藏文件。 */
const SAFE_MEMORY_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/**
 * case 的 memory 声明校验：返回错误描述，合法（或没配）时返回 null。
 * 用户面报错要说清「哪个题、哪个文件名、为什么不行」——这些是写题的人当场要改的东西。
 */
export function validateCaseMemory(testCase: TestCase): string | null {
  const memory = testCase.memory;
  if (memory === undefined) return null;
  if (memory.enabled !== true) {
    return 'memory.enabled 必须显式写 true（要么删掉整个 memory 段，要么开它——没有"声明了但不开"这一档）';
  }
  const seed = memory.seed;
  if (seed === undefined) return null;
  if (!Array.isArray(seed.files) || seed.files.length === 0) {
    return 'memory.seed.files 必须是非空数组（不预置任何记忆就别写 seed 段）';
  }
  const seen = new Set<string>();
  for (const file of seed.files) {
    if (typeof file?.name !== 'string' || !SAFE_MEMORY_FILENAME.test(file.name)) {
      return `memory.seed.files 里的文件名 ${JSON.stringify(file?.name)} 不合法：只允许字母数字开头的 .md 文件名，不能带目录或 ..`;
    }
    if (typeof file.content !== 'string' || file.content.length === 0) {
      return `memory.seed.files 里 ${file.name} 的 content 必须是非空字符串`;
    }
    if (seen.has(file.name)) return `memory.seed.files 里 ${file.name} 出现了两次`;
    seen.add(file.name);
  }
  return null;
}

/**
 * 起跑前把 seed 落进本题的记忆目录并重建索引。返回真正写进去的文件名。
 *
 * 隔离硬闸：没有 CODE_AGENT_DATA_DIR 时 getMemoryDir() 会落到 <home>/.code-agent/memory——
 * 那是用户真实的记忆库。评测往那里写就是污染生产数据，所以这里直接抛，不做"尽力而为"。
 */
export async function seedCaseMemory(memory: EvalCaseMemory): Promise<string[]> {
  // 闸在 enabled 上、不在 seed 上：没有 seed 的写入侧题同样会往记忆目录写，
  // 只挡 seed 等于放过了污染路径里更危险的那一半。
  if (!process.env.CODE_AGENT_DATA_DIR?.trim()) {
    throw new Error(
      '记忆题需要每题隔离的数据目录：CODE_AGENT_DATA_DIR 未设置，'
      + '此时记忆目录会落在用户真实的 ~/.code-agent/memory 上。'
      + '请通过事件桥（--event-stream）或显式设置 CODE_AGENT_DATA_DIR 后再跑记忆题。',
    );
  }
  const files = memory.seed?.files ?? [];
  if (files.length === 0) return [];
  for (const file of files) {
    if (file.content.trimStart().startsWith('---')) {
      throw new Error(
        `memory.seed.files 里 ${file.name} 的 content 不要自带 frontmatter：`
        + 'seed 只写记忆正文，name/description/type 由写入器生成（写重了索引会认不出这份文件）。',
      );
    }
    // 走产线写入器而不是裸 fs.writeFile：frontmatter 缺 name/description 的文件会被
    // rebuildLightMemoryIndex 跳过，那份 seed 就永远进不了提示词——「预置了但没人看见」。
    await writeLightMemoryFile({
      filename: file.name,
      name: file.name.replace(/\.md$/, ''),
      description: file.content.split('\n').map((line) => line.trim()).find(Boolean) ?? file.name,
      type: 'reference',
      content: file.content,
    });
  }
  const rebuild = await rebuildLightMemoryIndex();
  // fail-loud：seed 落了盘却没进索引 = 装好没接电。不在这里报的话，判定端只会表现成
  // 「模型没召回」——那是完全不同的病因，会把一次配置错误读成一次能力数据。
  const skipped = rebuild.skippedFiles.filter((item) => files.some((file) => file.name === item.filename));
  if (skipped.length > 0) {
    throw new Error(
      `记忆 seed 落盘了但没进索引（模型看不见）：${skipped.map((item) => `${item.filename}（${item.reason}）`).join('、')}`,
    );
  }
  return files.map((file) => file.name);
}

/**
 * 一题的记忆准备：先校验声明，再把声明交给 adapter（seed 就在那一刻落盘）。
 * 返回错误描述给 runner 判红，返回 null 表示可以起跑。两步合一是因为它们必须同进同退——
 * 校验过了但落盘失败还继续跑，等于拿一次「记忆压根没开」的跑分当能力数据。
 */
export async function applyCaseMemory(
  testCase: TestCase,
  configure: ((memory: EvalCaseMemory | undefined) => Promise<void>) | undefined,
): Promise<string | null> {
  const configError = validateCaseMemory(testCase);
  if (configError) return configError;
  try {
    await configure?.(testCase.memory);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 跑完、cleanup 之前对记忆目录做正文快照（memory_written 判定的证据源）。 */
export async function snapshotMemoryDir(): Promise<MemoryFileSnapshot[]> {
  const dir = getMemoryDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const snapshot: MemoryFileSnapshot[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    try {
      snapshot.push({ name, content: await fs.readFile(path.join(dir, name), 'utf-8') });
    } catch {
      // 读不到的条目不进快照；判定读到的永远是"确实读出来的正文"
    }
  }
  return snapshot;
}

function parsePatterns(params: Record<string, unknown>, key: string): RegExp[] | string {
  const value = params[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    return `${key} must be a non-empty string array`;
  }
  try {
    return value.map((pattern) => new RegExp(pattern as string, 'i'));
  } catch (error: unknown) {
    return `${key} contains an invalid regex: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function parseBoolean(params: Record<string, unknown>, key: string): boolean | string {
  const value = params[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') return `${key} must be a boolean`;
  return value;
}

function invalid(type: string, reason: string): MemoryEvaluation {
  return { passed: false, actual: `invalid params: ${reason}`, expected: `valid ${type} params`, details: reason };
}

// ----------------------------------------------------------------------------
// memory_recalled
// ----------------------------------------------------------------------------

/**
 * memory_recalled —— 「本题该被想起来的记忆条目，真的被注进这一轮的提示词了吗」。
 *
 * params:
 *   entries  必填 regex 列表，匹配注入块里报出的条目名（light memory 文件名 / packed 条目 id）
 *   mode     'any'（默认）= 任一命中即过；'all' = 每条 regex 都要有条目命中
 *   negate   true = 反向（abstention 题：这些条目**不该**被注入）
 *
 * 证据源 = adapter 记录的 memory_injected 事件（含 entries）。没有记录来源时 fail-loud。
 * 注意「注了但没报 entries」也算没有证据：那种块只能证明注了点什么，证明不了注的是哪条。
 */
export function evaluateMemoryRecalledExpectation(
  params: Record<string, unknown>,
  record: MemoryRecallRecord | undefined,
): MemoryEvaluation {
  const patterns = parsePatterns(params, 'entries');
  if (typeof patterns === 'string') return invalid('memory_recalled', patterns);
  if (patterns.length === 0) return invalid('memory_recalled', 'entries must be a non-empty string array');
  const negate = parseBoolean(params, 'negate');
  if (typeof negate === 'string') return invalid('memory_recalled', negate);
  const rawMode = params.mode ?? 'any';
  if (rawMode !== 'any' && rawMode !== 'all') return invalid('memory_recalled', "mode must be 'any' or 'all'");

  const expected = negate
    ? 'none of the declared memory entries injected'
    : rawMode === 'all' ? 'every declared memory entry injected' : 'at least one declared memory entry injected';

  if (record === undefined) {
    return {
      passed: false,
      actual: 'no memory injection trace available',
      expected,
      details: 'adapter 没有接记忆注入记录器，判定没有证据源（mock 或旧 adapter）',
    };
  }

  const injected = record.entries;
  const hits = patterns.filter((pattern) => injected.some((entry) => pattern.test(entry)));
  const matched = rawMode === 'all' ? hits.length === patterns.length : hits.length > 0;
  const passed = negate ? !matched : matched;
  return {
    passed,
    actual: injected.length === 0 ? 'no memory entries injected' : injected,
    expected,
    details: `本题记忆注入 ${record.injections} 次，报出条目 ${injected.length} 条；`
      + `${patterns.length} 条判据命中 ${hits.length} 条（mode=${rawMode}${negate ? '，negate' : ''}）`,
  };
}

// ----------------------------------------------------------------------------
// memory_written
// ----------------------------------------------------------------------------

/** 去重口径：去掉列表符号/标点/空白差异后逐行比较，只看"同一句事实有没有落两遍"。 */
function normalizeFactLine(line: string): string {
  return line
    .replace(/^[\s\-*+>#]+/, '')
    .replace(/[\s`"'“”‘’.,;:!?。，、；：！？]/g, '')
    .toLowerCase();
}

function findDuplicateFacts(snapshot: MemoryFileSnapshot[]): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const file of snapshot) {
    for (const raw of file.content.split('\n')) {
      const normalized = normalizeFactLine(raw);
      // 太短的行（标题字符、frontmatter 分隔线）不参与去重判定，噪音大于信号
      if (normalized.length < 12) continue;
      const first = seen.get(normalized);
      if (first === undefined) seen.set(normalized, file.name);
      else if (first !== file.name) duplicates.push(`${raw.trim()} （${first} / ${file.name}）`);
    }
  }
  return duplicates;
}

/**
 * memory_written —— 「跑完之后记忆目录里真正躺着什么」。
 *
 * params（至少给一个）:
 *   contains       regex 列表，对全部记忆文件正文，每条都要有文件命中
 *   not_contains   regex 列表，一条都不许命中
 *   no_duplicates  true = 同一条事实不许跨文件重复落两份（口径见 normalizeFactLine）
 *   no_sensitive   true = 全部正文过 guardSensitiveText，脱敏后有变化即判有敏感内容漏写
 *
 * 证据源 = adapter 在本次 run 结束、cleanup 之前对记忆目录做的快照。没有快照时 fail-loud
 * ——「目录是空的」和「压根没人给我快照」必须分开，否则关着记忆的 case 会全部假绿。
 */
export function evaluateMemoryWrittenExpectation(
  params: Record<string, unknown>,
  snapshot: MemoryFileSnapshot[] | undefined,
): MemoryEvaluation {
  const contains = parsePatterns(params, 'contains');
  if (typeof contains === 'string') return invalid('memory_written', contains);
  const notContains = parsePatterns(params, 'not_contains');
  if (typeof notContains === 'string') return invalid('memory_written', notContains);
  const noDuplicates = parseBoolean(params, 'no_duplicates');
  if (typeof noDuplicates === 'string') return invalid('memory_written', noDuplicates);
  const noSensitive = parseBoolean(params, 'no_sensitive');
  if (typeof noSensitive === 'string') return invalid('memory_written', noSensitive);
  if (contains.length === 0 && notContains.length === 0 && !noDuplicates && !noSensitive) {
    return invalid('memory_written', 'at least one of contains, not_contains, no_duplicates, or no_sensitive must be provided');
  }

  const expected = 'memory files satisfy the declared write conditions';
  if (snapshot === undefined) {
    return {
      passed: false,
      actual: 'no memory directory snapshot available',
      expected,
      details: 'adapter 没有对记忆目录快照，判定没有证据源（mock 或旧 adapter）',
    };
  }

  const failures: string[] = [];
  const body = snapshot.map((file) => file.content).join('\n');

  for (const pattern of contains) {
    if (!pattern.test(body)) failures.push(`contains 未命中：${pattern.source}`);
  }
  for (const pattern of notContains) {
    if (pattern.test(body)) failures.push(`not_contains 被命中：${pattern.source}`);
  }
  if (noDuplicates) {
    for (const duplicate of findDuplicateFacts(snapshot)) failures.push(`重复落盘：${duplicate}`);
  }
  if (noSensitive) {
    for (const file of snapshot) {
      const guarded = guardSensitiveText(file.content, { surface: 'memory', mode: 'local-persist' });
      if (guarded !== file.content) failures.push(`${file.name} 含未脱敏的敏感内容`);
    }
  }

  return {
    passed: failures.length === 0,
    actual: failures.length === 0 ? 'memory files satisfy the declared write conditions' : failures,
    expected,
    details: `已检查 ${snapshot.length} 份记忆文件（${snapshot.map((file) => file.name).join(', ') || '目录为空'}）`,
  };
}
