#!/usr/bin/env npx tsx
// ============================================================================
// GDPval 逐条 rubric 评分 CLI（N-PATROL-GDPVAL-RUBRIC）
// ----------------------------------------------------------------------------
// 用法：
//   npx tsx scripts/gdpval-rubric-score.ts --patrol ~/work/patrol --run 2026-09-19
//   npx tsx scripts/gdpval-rubric-score.ts --patrol ~/work/patrol --run 2026-09-19 --only gdp-83d10b06 --batch 20 --call-timeout 300
//
// 评的是**产物**不是轨迹：读夜巡归档的 runs/<夜>/artifacts/<题号>/，把文件内容连同
// 该题自带的 rubric 逐条问评分模型。与 postlaunch-score.ts 的六维无题判官各管一段，
// 理由见 scripts/lib/gdpvalRubric.ts 文件头。
//
// 模型走 quickTask（routing.fast），与 postlaunch-score 同一只——GDPval 一题中位 47 条
// 判据，用贵模型逐条判不划算，而这些条目大多是「有没有这张表」「z 值是不是 1.64」
// 这类可核验事实，不需要强推理。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { getConfigService } from '../src/host/services/core/configService';
import { quickTask, getQuickModelRuntimeInfo } from '../src/host/model/quickModel';
import {
  buildRubricPrompt,
  chunkRubric,
  isInsideRoot,
  TRUNCATED_MARK,
  parseRubricVerdicts,
  summarizeTask,
  type GdpvalArtifactFile,
  type GdpvalItemVerdict,
  type GdpvalRubricItem,
} from './lib/gdpvalRubric';

// 额度按「128k 上下文留一半给资料」定：产物标称 12 万 + 输入 6 万 = 18 万字符 ≈ 6 万 token。
// 两个都是软上限（判断在累加之前），最坏情况各多一个 MAX_FILE_CHARS，合计约 30 万字符。
// 8000 字那版实测把 1516 行的明细表截到 40 行，rubric 里「表里至少有一行满足 X」
// 整片判 false，分数与产物质量脱钩。
/** 单文件提取上限。 */
const MAX_FILE_CHARS = 60000;
/**
 * 一题所有产物合计上限。**软上限**：判断在累加之前，所以最后读进来的那个文件
 * 可能让总量超出至多一个 MAX_FILE_CHARS。这样定是为了「最后一个文件要么整份给、
 * 要么整份不给」，半截给会让截断标注失真。
 */
const MAX_TASK_CHARS = 120000;
/** 一题原始输入（题目给的参考文件）合计上限，同样是软上限；对照类判据要用，但不该把产物挤出去。 */
const MAX_INPUT_CHARS = 60000;
/**
 * 不进产物清单的目录：agent 为了干活装的依赖树不是它的交付物。
 * 实测 gdp-476db143 为了读两个 PDF 装了 `.venv`，产物清单直接变成 577 个文件——
 * 提取额度被吃光，提示词里也全是无关文件名。
 */
// 只跳**依赖与缓存**树。dist / build / .next 不在表里：那是构建输出，
// 一份网页报告、一个打包好的站点很可能正是交付物，跳掉就静默漏读、条目全判未满足。
const SKIP_DIRS = new Set(['.code-agent', '.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache']);
/** 产物文件数上限；再多也只是噪声，超出的只报数量。 */
const MAX_FILES = 60;
/** 展开内容的工作表数上限；与 perSheet 配套，保证不顶穿 MAX_FILE_CHARS。 */
const MAX_SHEETS = 15;
/**
 * 逐条列出的占位条数上限，超出的合并成一条汇总。
 * 占位本身也要有上限：`.next/cache` 能有几千个文件，几千条占位就是几十万字符，
 * 顶穿上下文后每批调用都失败，重试完记全部未判——落一个 ratio:0 的假零分，
 * 与「产物确实不合格」分不开。
 */
const MAX_PLACEHOLDERS = 20;
/** 调用失败的重试退避；最后一档给足是因为智谱 429 通常要等几十秒才放行。 */
const RETRY_BACKOFF_MS = [5000, 20000, 60000];
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.py', '.js', '.ts', '.css', '.yaml', '.yml', '.log', '.sql']);

/** 非法数值参数当场退出，不带着 NaN 往下跑——chunkRubric 的循环遇到 NaN 会永不前进。 */
function readPositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${flag} 要一个正整数，收到 ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
}

/** 只展开 `~` 与 `~/`：`~someuser/x` 是别人的家目录，改写成 $HOME + someuser/x 是个不存在的路径。 */
function expandHome(value: string): string {
  if (value !== '~' && !value.startsWith('~/')) return value;
  return path.join(process.env.HOME ?? '~', value.slice(1));
}

function parseArgs(): { patrol: string; run: string; only: string[]; batch: number; out: string | null; limit: number; callTimeoutMs: number } {
  const argv = process.argv.slice(2);
  // 漏写值不能静默退化：`--only` 后面跟着另一个 flag（或什么都没有）时，
  // 旧写法会读成 undefined 然后「不过滤」，直接把整个题库开评——几百次付费调用。
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`${flag} 后面要跟一个值`);
      process.exit(2);
    }
    return value;
  };
  const patrol = read('--patrol');
  const run = read('--run');
  if (!patrol || !run) {
    console.error('用法：--patrol <patrol 根目录> --run <夜> [--only id,id] [--batch 40] [--out file.jsonl] [--limit N] [--call-timeout 秒]');
    process.exit(2);
  }
  return {
    patrol: expandHome(patrol),
    run,
    only: (read('--only') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    batch: readPositiveInt(read('--batch'), 40, '--batch'),
    out: (() => { const raw = read('--out'); return raw === undefined ? null : expandHome(raw); })(),
    limit: read('--limit') === undefined ? 0 : readPositiveInt(read('--limit'), 0, '--limit'),
    callTimeoutMs: readPositiveInt(read('--call-timeout'), 180, '--call-timeout') * 1000,
  };
}

/**
 * 产物提取。xlsx/docx 直连底层库（4 行），不复用 src 的 read_xlsx / read_docx 工具——
 * 那两个是 ToolHandler，要先造一份 ToolContext（logger/workspace/权限/artifacts），
 * 而 read_pdf 还会按配置走模型 OCR，在评分脚本里既慢又花钱。
 * ponytail: pdf/pptx 只留文件名与大小，rubric 里「产物是不是 PDF、叫什么名」那类条目照样判得了；
 * 要判 PDF 正文时再接 poppler pdftotext（仓里已有 sidecar，见 scripts/lib/poppler-sidecar-release.mjs）。
 */
async function extractFile(absPath: string, relPath: string): Promise<GdpvalArtifactFile> {
  let bytes = 0;
  const ext = path.extname(absPath).toLowerCase();
  // 截断要说清楚截了多少：模型据此把「整表存在性」类判据填 unknown 而不是硬判 false。
  const clip = (value: string): string => {
    if (value.length <= MAX_FILE_CHARS) return value;
    const lines = value.split('\n').length;
    const kept = value.slice(0, MAX_FILE_CHARS);
    return `${kept}…\n[本文件共 ${lines} 行，以上只给出前 ${kept.split('\n').length} 行]`;
  };
  try {
    bytes = fs.statSync(absPath).size;
    if (TEXT_EXT.has(ext)) return { path: relPath, bytes, text: clip(fs.readFileSync(absPath, 'utf8')) };
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
      const workbook = XLSX.read(fs.readFileSync(absPath), { type: 'buffer' });
      // 每张表单独分配额度，不是整本截前 8000 字——第一张明细表动辄十几万字符，
      // 先 join 再截会把后面的表整个吃掉（自验实测：'Sample Size' 表连同它的置信水平、
      // 总体量 N、样本量全没进提示词，模型据此把三条判据全判成「没有」）。
      // 每张表的下限和表数上限要一起定，否则 20 张表 × 4000 字就把单文件上限顶穿了。
      // 展开前 MAX_SHEETS 张，其余只报表名与行数——多工作表工作簿的主表通常在前面。
      const perSheet = Math.floor(MAX_FILE_CHARS / Math.min(workbook.SheetNames.length, MAX_SHEETS));
      const sheets = workbook.SheetNames.map((name, index) => {
        const sheet = workbook.Sheets[name];
        if (index >= MAX_SHEETS) {
          // 未展开的表不做全量 sheet_to_csv，只从 !ref 读范围拿行数。
          const ref = sheet['!ref'];
          const rows = ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
          return `# sheet: ${name}（共 ${rows} 行，${TRUNCATED_MARK}）`;
        }
        const csv = XLSX.utils.sheet_to_csv(sheet);
        const rows = csv.split('\n').length;
        if (csv.length <= perSheet) return `# sheet: ${name}（共 ${rows} 行）\n${csv}`;
        const kept = csv.slice(0, perSheet);
        return `# sheet: ${name}（共 ${rows} 行，以下只给出前 ${kept.split('\n').length} 行）\n${kept}…`;
      });
      // 未展开的表也各自占一行表头，表数很多时这些行加起来能超 MAX_FILE_CHARS，兜底再 clip 一次。
      return { path: relPath, bytes, text: clip(sheets.join('\n')) };
    }
    if (ext === '.docx') {
      const extracted = await mammoth.extractRawText({ buffer: fs.readFileSync(absPath) });
      return { path: relPath, bytes, text: clip(extracted.value) };
    }
  } catch (error) {
    return unseen(relPath, bytes, `提取失败 ${error instanceof Error ? error.message : String(error)}`);
  }
  return unseen(relPath, bytes, `binary ${ext || 'no-ext'}，没有解析器`);
}

/**
 * 「这份文件的正文没给模型看」的唯一构造口。**所有出口都必须走它**：
 * 超额度、文件数超限、二进制没解析器、提取抛错——四种原因在提示词里必须长一个样，
 * 因为模型认的是 TRUNCATED_MARK 这个词，认不出就按「产物里没有」判 false 并计入分母，
 * 落一个与「产物确实不合格」分不开的假零分。
 */
function unseen(relPath: string, bytes: number, reason: string): GdpvalArtifactFile {
  return { path: relPath, bytes, text: `[${TRUNCATED_MARK}：${reason}]` };
}

/** 文件是不是只给了占位（没让模型看正文）。落盘证据靠它打标签。 */
function isUnseen(file: GdpvalArtifactFile): boolean {
  return file.text.startsWith(`[${TRUNCATED_MARK}`);
}

function safeSize(absPath: string): number {
  try { return fs.statSync(absPath).size; } catch { return 0; }
}

/**
 * 按额度收文件，超出的一律留 TRUNCATED_MARK 占位——**三处截断（产物字数、产物个数、
 * 输入字数）必须走同一个函数**。此前它们各写各的，改一处露一处：
 * 产物字数超额留了占位、产物个数超额整条丢弃、输入超额直接 break，
 * 三种降级三种行为，而只有留占位的那种会让模型按弃权判、从分母剔除。
 * 对称性由这个函数保证，不靠每次记得。
 */
async function collectWithinBudget(
  entries: Array<{ abs: string; rel: string }>,
  maxFiles: number,
  maxChars: number,
): Promise<{ files: GdpvalArtifactFile[]; skipped: number }> {
  const files: GdpvalArtifactFile[] = [];
  let used = 0;
  let skipped = 0;
  for (const [index, entry] of entries.entries()) {
    if (index >= maxFiles || used >= maxChars) {
      skipped += 1;
      if (skipped <= MAX_PLACEHOLDERS) {
        files.push(unseen(entry.rel, safeSize(entry.abs), '超出本题提取额度'));
      }
      continue;
    }
    const file = await extractFile(entry.abs, entry.rel);
    used += file.text.length;
    files.push(file);
  }
  if (skipped > MAX_PLACEHOLDERS) {
    files.push(unseen(`（另有 ${skipped - MAX_PLACEHOLDERS} 个文件）`, 0, '超出本题提取额度'));
  }
  return { files, skipped };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out.sort();
}

async function main(): Promise<void> {
  const options = parseArgs();
  // 不 reload 就读不到磁盘上的 config.json，routing 一路用默认值（zhipu/glm-4-flash），
  // 在夜巡机器上那条路恒 401（N-QUICKMODEL-ZHIPU-401）——排查了半天「key 为什么失效」，
  // 真因是这一行没写。postlaunch-score.ts 一直有它，我照抄时漏了。
  // reloadFromDisk 刻意不做 keychain / migrate / save，不会回写用户配置。
  await getConfigService().reloadFromDisk();
  const bankPath = path.join(options.patrol, 'gdpval.json');
  if (!fs.existsSync(bankPath)) {
    console.error(`找不到题库 ${bankPath}`);
    process.exit(1);
  }
  const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8')) as Array<{
    id: string;
    _occupation?: string;
    _rubric?: GdpvalRubricItem[];
    /** 题目给的参考文件绝对路径；对照类判据要拿它当基准。 */
    _reference_files?: string[];
  }>;
  const artifactsRoot = path.join(options.patrol, 'runs', options.run, 'artifacts');
  const judge = getQuickModelRuntimeInfo();
  console.log(`题库：${bankPath}（${bank.length} 题）`);
  console.log(`产物：${artifactsRoot}`);
  console.log(`评分模型：${judge ? `${judge.provider}/${judge.model}` : '未配置'}`);
  if (!judge) process.exit(1);

  let tasks = bank.filter((task) => Array.isArray(task._rubric) && task._rubric.length > 0);
  if (options.only.length > 0) {
    // --only 先生效：题号打错和「该夜没产物」要分得开，都报「本次评 0 题」查不出是哪种。
    const missing = options.only.filter((id) => !tasks.some((task) => task.id === id));
    if (missing.length > 0) console.warn(`题库里没有这些题（或它们没有 rubric）：${missing.join(', ')}`);
    tasks = tasks.filter((task) => options.only.includes(task.id));
  }
  const withoutArtifacts = tasks.filter((task) => !fs.existsSync(path.join(artifactsRoot, task.id)));
  if (options.only.length > 0 && withoutArtifacts.length > 0) {
    console.warn(`这一夜没有产物，跳过：${withoutArtifacts.map((task) => task.id).join(', ')}`);
  }
  tasks = tasks.filter((task) => isInsideRoot(artifactsRoot, path.join(artifactsRoot, task.id))
    && fs.existsSync(path.join(artifactsRoot, task.id)));
  if (options.limit > 0) tasks = tasks.slice(0, options.limit);
  console.log(`本次评 ${tasks.length} 题（题库有 rubric 且这一夜留下了产物的）\n`);

  const outPath = options.out ?? path.join(options.patrol, 'runs', options.run, 'gdpval-rubric.jsonl');
  // 覆盖而不是追加：一次运行 = 这一夜这批题的结果，追加会让重跑同一夜留下重复行。
  const out = fs.createWriteStream(outPath, { flags: 'w' });
  // 不挂 error 监听时，--out 指向不存在的目录会抛 unhandled 'error' 把进程带走。
  out.on('error', (error) => {
    console.error(`结果文件写不了 ${outPath}：${error.message}`);
    process.exit(1);
  });
  let calls = 0;
  for (const task of tasks) {
    const taskRoot = path.join(artifactsRoot, task.id);   // 根边界已在上面的 tasks 过滤里挡过
    const allRels = listFiles(taskRoot);
    const { files, skipped: skippedForBudget } = await collectWithinBudget(
      allRels.map((rel) => ({ abs: path.join(taskRoot, rel), rel })),
      MAX_FILES,
      MAX_TASK_CHARS,
    );
    if (skippedForBudget > 0) {
      console.warn(`  ${task.id}：产物总量超过 ${MAX_TASK_CHARS} 字，${skippedForBudget} 个文件没给模型看正文`
        + '（这些文件相关的条目会被判弃权，不是判负）');
    }
    const refEntries: Array<{ abs: string; rel: string }> = [];
    for (const abs of task._reference_files ?? []) {
      if (!isInsideRoot(options.patrol, abs)) {
        console.warn(`  ${task.id}：参考文件指向 patrol 根之外，跳过 ${abs}`);
        continue;
      }
      if (!fs.existsSync(abs)) {
        console.warn(`  ${task.id}：参考文件不在 ${abs}`);
        continue;
      }
      // 用相对 patrol 根的路径当标签：basename(dirname)/basename 在不同祖先下
      // 同名父目录时会撞成同一个 path，模型就分不清两份同名输入。
      refEntries.push({ abs, rel: path.relative(options.patrol, abs) });
    }
    const { files: inputs, skipped: inputsSkipped } = await collectWithinBudget(
      refEntries,
      MAX_FILES,
      MAX_INPUT_CHARS,
    );
    if (inputsSkipped > 0) {
      console.warn(`  ${task.id}：参考文件总量超过 ${MAX_INPUT_CHARS} 字，${inputsSkipped} 个没给模型看正文`
        + '（这些文件相关的条目会被判弃权，不是判负）');
    }

    const rubric = task._rubric as GdpvalRubricItem[];
    const verdicts: GdpvalItemVerdict[] = [];
    for (const batch of chunkRubric(rubric, options.batch)) {
      const prompt = buildRubricPrompt(batch, files, inputs);
      // 失败要重试够：一次 500 或 429 会让整批条目全变未判、整题记 0 分，
      // 那是个假信号——它看起来和「产物确实不合格」一模一样。
      // 退避要拉开：实测智谱 429（code 1305「访问量过大」）在 3 秒后照样 429，
      // 而夜巡一晚要为 216 道题发几百次调用，撞限流是常态不是意外。
      let content = '';
      for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1 && !content; attempt += 1) {
        if (attempt > 0) {
          const wait = RETRY_BACKOFF_MS[attempt - 1];
          await new Promise((resolve) => { setTimeout(resolve, wait); });
        }
        const more = attempt < RETRY_BACKOFF_MS.length ? `，${RETRY_BACKOFF_MS[attempt] / 1000} 秒后重试` : '，不再重试';
        try {
          // 不给超时，模型服务挂起时整夜评分会停在这一批上，后面的题一道都不落盘。
          calls += 1;   // 计在发起处：抛错的那次也是真花了钱的，记在 await 之后会低报付费量
          const response = await quickTask(prompt, 6000, AbortSignal.timeout(options.callTimeoutMs));
          content = response.success && response.content ? response.content : '';
          if (!content) console.warn(`  ${task.id}：模型没返回内容（${response.error ?? '无错误信息'}）${more}`);
        } catch (error) {
          console.warn(`  ${task.id}：调用失败${more}`, error);
        }
      }
      verdicts.push(...parseRubricVerdicts(content, batch));
    }

    // 落盘的 files 标出哪些只留了占位：事后要能看出「这条判负」是不是因为文件压根没进提示词。
    const seenPaths = new Set(files.filter((file) => !isUnseen(file)).map((file) => file.path));
    const fileLabels = allRels.map((rel) => (seenPaths.has(rel) ? rel : `${rel} [${TRUNCATED_MARK}]`));
    const score = summarizeTask(task.id, verdicts, fileLabels, task._occupation);
    out.write(`${JSON.stringify(score)}\n`);
    console.log(`${task.id.padEnd(16)} ${(score.ratio * 100).toFixed(0).padStart(3)}%  ${score.earned}/${score.total} 分`
      + `（满分 ${score.totalRaw}，弃权 ${score.abstained} 条已剔出分母）`
      + `  条目 ${verdicts.length}${score.unjudged > 0 ? `（漏判 ${score.unjudged}）` : ''}`
      + `  产物 ${allRels.length} 个  输入 ${inputs.length} 个`);
  }
  out.end();
  console.log(`\n结果：${outPath}；模型调用 ${calls} 次`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
