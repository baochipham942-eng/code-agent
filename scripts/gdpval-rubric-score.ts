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
import { quickTask, getQuickModelRuntimeInfo } from '../src/host/model/quickModel';
import {
  buildRubricPrompt,
  chunkRubric,
  parseRubricVerdicts,
  summarizeTask,
  type GdpvalArtifactFile,
  type GdpvalItemVerdict,
  type GdpvalRubricItem,
} from './lib/gdpvalRubric';

// 额度按「128k 上下文的一半留给资料」定：产物 + 输入 ≈ 12 万字符 ≈ 4 万 token。
// 8000 字那版实测把 1516 行的明细表截到 40 行，rubric 里「表里至少有一行满足 X」
// 整片判 false，分数与产物质量脱钩。
/** 单文件提取上限。 */
const MAX_FILE_CHARS = 60000;
/** 一题所有产物合计上限。 */
const MAX_TASK_CHARS = 120000;
/** 一题原始输入（题目给的参考文件）合计上限；对照类判据要用，但不该把产物挤出去。 */
const MAX_INPUT_CHARS = 60000;
/**
 * 不进产物清单的目录：agent 为了干活装的依赖树不是它的交付物。
 * 实测 gdp-476db143 为了读两个 PDF 装了 `.venv`，产物清单直接变成 577 个文件——
 * 提取额度被吃光，提示词里也全是无关文件名。
 */
const SKIP_DIRS = new Set(['.code-agent', '.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', 'dist', 'build', '.next', '.cache']);
/** 产物文件数上限；再多也只是噪声，超出的只报数量。 */
const MAX_FILES = 60;
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

function parseArgs(): { patrol: string; run: string; only: string[]; batch: number; out: string | null; limit: number; callTimeoutMs: number } {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const patrol = read('--patrol');
  const run = read('--run');
  if (!patrol || !run) {
    console.error('用法：--patrol <patrol 根目录> --run <夜> [--only id,id] [--batch 40] [--out file.jsonl] [--limit N] [--call-timeout 秒]');
    process.exit(2);
  }
  return {
    patrol: patrol.replace(/^~/, process.env.HOME ?? '~'),
    run,
    only: (read('--only') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    batch: readPositiveInt(read('--batch'), 40, '--batch'),
    out: read('--out') ?? null,
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
  const bytes = fs.statSync(absPath).size;
  const ext = path.extname(absPath).toLowerCase();
  // 截断要说清楚截了多少：模型据此把「整表存在性」类判据填 unknown 而不是硬判 false。
  const clip = (value: string): string => {
    if (value.length <= MAX_FILE_CHARS) return value;
    const lines = value.split('\n').length;
    const kept = value.slice(0, MAX_FILE_CHARS);
    return `${kept}…\n[本文件共 ${lines} 行，以上只给出前 ${kept.split('\n').length} 行]`;
  };
  try {
    if (TEXT_EXT.has(ext)) return { path: relPath, bytes, text: clip(fs.readFileSync(absPath, 'utf8')) };
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
      const workbook = XLSX.read(fs.readFileSync(absPath), { type: 'buffer' });
      // 每张表单独分配额度，不是整本截前 8000 字——第一张明细表动辄十几万字符，
      // 先 join 再截会把后面的表整个吃掉（自验实测：'Sample Size' 表连同它的置信水平、
      // 总体量 N、样本量全没进提示词，模型据此把三条判据全判成「没有」）。
      const perSheet = Math.max(4000, Math.floor(MAX_FILE_CHARS / workbook.SheetNames.length));
      const sheets = workbook.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
        if (csv.length <= perSheet) return `# sheet: ${name}（共 ${csv.split('\n').length} 行）\n${csv}`;
        const kept = csv.slice(0, perSheet);
        return `# sheet: ${name}（共 ${csv.split('\n').length} 行，以下只给出前 ${kept.split('\n').length} 行）\n${kept}…`;
      });
      return { path: relPath, bytes, text: sheets.join('\n') };
    }
    if (ext === '.docx') {
      const extracted = await mammoth.extractRawText({ buffer: fs.readFileSync(absPath) });
      return { path: relPath, bytes, text: clip(extracted.value) };
    }
  } catch (error) {
    return { path: relPath, bytes, text: `[提取失败：${error instanceof Error ? error.message : String(error)}]` };
  }
  return { path: relPath, bytes, text: `[binary ${ext || 'no-ext'}，未提取正文]` };
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

  let tasks = bank.filter((task) => Array.isArray(task._rubric) && task._rubric.length > 0
    && fs.existsSync(path.join(artifactsRoot, task.id)));
  if (options.only.length > 0) tasks = tasks.filter((task) => options.only.includes(task.id));
  if (options.limit > 0) tasks = tasks.slice(0, options.limit);
  console.log(`本次评 ${tasks.length} 题（题库有 rubric 且这一夜留下了产物的）\n`);

  const outPath = options.out ?? path.join(options.patrol, 'runs', options.run, 'gdpval-rubric.jsonl');
  // 覆盖而不是追加：一次运行 = 这一夜这批题的结果，追加会让重跑同一夜留下重复行。
  const out = fs.createWriteStream(outPath, { flags: 'w' });
  let calls = 0;
  for (const task of tasks) {
    const taskRoot = path.join(artifactsRoot, task.id);
    const allRels = listFiles(taskRoot);
    const rels = allRels.slice(0, MAX_FILES);
    if (allRels.length > MAX_FILES) console.warn(`  ${task.id}：产物 ${allRels.length} 个，只取前 ${MAX_FILES} 个`);
    const files: GdpvalArtifactFile[] = [];
    let used = 0;
    for (const rel of rels) {
      if (used >= MAX_TASK_CHARS) {
        files.push({ path: rel, bytes: fs.statSync(path.join(taskRoot, rel)).size, text: '[超出本题提取上限，未读正文]' });
        continue;
      }
      const file = await extractFile(path.join(taskRoot, rel), rel);
      used += file.text.length;
      files.push(file);
    }

    const inputs: GdpvalArtifactFile[] = [];
    let inputUsed = 0;
    for (const abs of task._reference_files ?? []) {
      if (!fs.existsSync(abs)) {
        console.warn(`  ${task.id}：参考文件不在 ${abs}`);
        continue;
      }
      if (inputUsed >= MAX_INPUT_CHARS) break;
      const file = await extractFile(abs, path.basename(abs));
      inputUsed += file.text.length;
      inputs.push(file);
    }

    const rubric = task._rubric as GdpvalRubricItem[];
    const verdicts: GdpvalItemVerdict[] = [];
    for (const batch of chunkRubric(rubric, options.batch)) {
      const prompt = buildRubricPrompt(batch, files, inputs);
      // 瞬时 5xx 重试一次：一次 500 会让整批条目全变未判、整题记 0 分，
      // 那是个假信号——它看起来和「产物确实不合格」一模一样（实测撞到过一次）。
      let content = '';
      for (let attempt = 0; attempt < 2 && !content; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => { setTimeout(resolve, 3000); });
        try {
          // 不给超时，模型服务挂起时整夜评分会停在这一批上，后面的题一道都不落盘。
          const response = await quickTask(prompt, 6000, AbortSignal.timeout(options.callTimeoutMs));
          calls += 1;
          content = response.success && response.content ? response.content : '';
          if (!content) console.warn(`  ${task.id}：模型没返回内容（${response.error ?? '无错误信息'}）${attempt === 0 ? '，重试一次' : ''}`);
        } catch (error) {
          console.warn(`  ${task.id}：调用失败${attempt === 0 ? '，重试一次' : ''}`, error);
        }
      }
      verdicts.push(...parseRubricVerdicts(content, batch));
    }

    const score = summarizeTask(task.id, verdicts, allRels, task._occupation);
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
