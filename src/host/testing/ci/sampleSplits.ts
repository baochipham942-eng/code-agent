// ============================================================================
// WP1b 样本工程 — held-in/held-out 切分
// ============================================================================
// 动机：日常迭代反复对着同一个子集调 prompt，分数会"学会考卷"（过拟合 eval）。
// 切分后 held-in 供日常迭代与 baseline 对账，held-out 只在里程碑检查——
// held-in 涨而 held-out 不涨 = 过拟合信号。GAIA validation 是天然 held-out
// 外部锚点（走 --case-dir 独立入口，不进本地 split，答案在公网不可反向调题）。
// control 桶：带确定性断言的 case 子集，judge 校准（judgeCalibration）的金标源。
//
// 切分是确定性的：sha256(seed + id) 排序取前 N —— 同 seed 必得同一套卷子，
// 且与输入顺序无关；换卷子必须显式换 seed（留痕在 splits 文件里）。
// ============================================================================

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../config/configPaths';

export interface EvalSplitFile {
  version: 1;
  /** 切分种子——换种子=换卷子，必须留痕 */
  seed: string;
  createdAt: string;
  /** 日常迭代 + baseline 对账用 */
  heldIn: string[];
  /** 只在里程碑检查（过拟合探测器），不进日常迭代 */
  heldOut: string[];
  /** judge 校准 control 集（带确定性断言，金标可用） */
  control: string[];
  note?: string;
}

export type SplitBucket = 'held-in' | 'held-out' | 'control';

const DEFAULT_HELD_OUT_RATIO = 0.4;

/** 确定性切分：按 sha256(seed:id) 排序，前 ceil(ratio*n) 为 held-out */
export function splitHeldInOut(
  caseIds: string[],
  opts: { seed: string; heldOutRatio?: number },
): { heldIn: string[]; heldOut: string[] } {
  const ratio = opts.heldOutRatio ?? DEFAULT_HELD_OUT_RATIO;
  const ranked = [...caseIds].sort((a, b) => hashOf(opts.seed, a).localeCompare(hashOf(opts.seed, b)));
  const heldOutCount = Math.ceil(ranked.length * ratio);
  const heldOutSet = new Set(ranked.slice(0, heldOutCount));
  return {
    heldIn: caseIds.filter((id) => !heldOutSet.has(id)).sort(),
    heldOut: caseIds.filter((id) => heldOutSet.has(id)).sort(),
  };
}

function hashOf(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/**
 * 把请求的 ids 过滤到指定桶：显式 ids 与桶取交集（挡住把 held-out 混进
 * 日常迭代的手滑），未给 ids 则返回桶内全量。
 */
export function applySplitFilter(
  ids: string[] | undefined,
  split: EvalSplitFile,
  bucket: SplitBucket,
): string[] {
  const bucketIds =
    bucket === 'held-in' ? split.heldIn : bucket === 'held-out' ? split.heldOut : split.control;
  if (!ids || ids.length === 0) return [...bucketIds];
  const allowed = new Set(bucketIds);
  return ids.filter((id) => allowed.has(id));
}

const SPLITS_FILE = 'eval-splits.json';

function splitsPath(workingDir: string): string {
  const base = path.basename(workingDir) === CONFIG_DIR_NEW ? workingDir : path.join(workingDir, CONFIG_DIR_NEW);
  return path.join(base, SPLITS_FILE);
}

export async function saveEvalSplits(workingDir: string, file: EvalSplitFile): Promise<void> {
  const target = splitsPath(workingDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(file, null, 2), 'utf-8');
}

export async function loadEvalSplits(workingDir: string): Promise<EvalSplitFile | null> {
  try {
    return JSON.parse(await fs.readFile(splitsPath(workingDir), 'utf-8')) as EvalSplitFile;
  } catch {
    return null;
  }
}
