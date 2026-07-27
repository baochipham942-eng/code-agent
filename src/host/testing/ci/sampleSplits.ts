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
  /** 破坏性/安全红线，只能在 OS jail 下运行，不进能力回归口径 */
  safety: string[];
  note?: string;
}

export type SplitBucket = 'held-in' | 'held-out' | 'control' | 'safety';

const DEFAULT_HELD_OUT_RATIO = 0.4;
export const EVAL_SPLITS_RELATIVE_PATH = path.join('.claude', 'eval-splits.json');

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
  const bucketIds = bucket === 'held-in'
    ? split.heldIn
    : bucket === 'held-out'
      ? split.heldOut
      : bucket === 'control'
        ? split.control
        : split.safety;
  if (!ids || ids.length === 0) return [...bucketIds];
  const allowed = new Set(bucketIds);
  return ids.filter((id) => allowed.has(id));
}

function splitsPath(workingDir: string): string {
  return path.join(workingDir, EVAL_SPLITS_RELATIVE_PATH);
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
  }
  return [...duplicateIds].sort();
}

/**
 * 版本化切分资产的硬门：
 * - seed 必须留痕；
 * - 能力三切与 safety 的边界必须可审计；
 * - control 只能取自 held-in，不能泄露 held-out；
 * - 给出当前 case 集时，资产必须完整覆盖且不引用幽灵 id。
 */
// 不导出：对外只暴露 assertValidEvalSplits（fail-closed 的那个入口）。
// 导出一个没人调的检查函数 = 假装有第二种用法，反而让人以为可以「只看不拦」。
function validateEvalSplits(
  file: EvalSplitFile,
  expected?: { allCaseIds: string[]; safetyCaseIds: string[] },
): string[] {
  const errors: string[] = [];
  if (file.version !== 1) errors.push(`unsupported version: ${String(file.version)}`);
  if (typeof file.seed !== 'string' || file.seed.trim().length === 0) errors.push('seed is required');
  for (const [name, ids] of Object.entries({
    heldIn: file.heldIn,
    heldOut: file.heldOut,
    control: file.control,
    safety: file.safety,
  })) {
    if (!Array.isArray(ids)) {
      errors.push(`${name} must be an array`);
      continue;
    }
    const duplicateIds = duplicates(ids);
    if (duplicateIds.length > 0) errors.push(`${name} contains duplicate ids: ${duplicateIds.join(', ')}`);
  }

  if (errors.length > 0) return errors;

  const heldIn = new Set(file.heldIn);
  const heldOut = new Set(file.heldOut);
  const control = new Set(file.control);
  const safety = new Set(file.safety);
  const overlap = (left: Set<string>, right: Set<string>) => [...left].filter((id) => right.has(id)).sort();

  for (const [label, ids] of [
    ['held-in/held-out', overlap(heldIn, heldOut)],
    ['held-in/safety', overlap(heldIn, safety)],
    ['held-out/safety', overlap(heldOut, safety)],
    ['control/held-out', overlap(control, heldOut)],
    ['control/safety', overlap(control, safety)],
  ] as const) {
    if (ids.length > 0) errors.push(`${label} overlap: ${ids.join(', ')}`);
  }
  const controlOutsideHeldIn = [...control].filter((id) => !heldIn.has(id)).sort();
  if (controlOutsideHeldIn.length > 0) {
    errors.push(`control must be a held-in subset: ${controlOutsideHeldIn.join(', ')}`);
  }

  if (expected) {
    const all = new Set(expected.allCaseIds);
    const partition = new Set([...file.heldIn, ...file.heldOut, ...file.safety]);
    const missing = [...all].filter((id) => !partition.has(id)).sort();
    const unknown = [...partition].filter((id) => !all.has(id)).sort();
    if (missing.length > 0) errors.push(`split is missing case ids: ${missing.join(', ')}`);
    if (unknown.length > 0) errors.push(`split contains unknown case ids: ${unknown.join(', ')}`);

    const expectedSafety = new Set(expected.safetyCaseIds);
    const missingSafety = [...expectedSafety].filter((id) => !safety.has(id)).sort();
    const unexpectedSafety = [...safety].filter((id) => !expectedSafety.has(id)).sort();
    if (missingSafety.length > 0) errors.push(`redline ids outside safety: ${missingSafety.join(', ')}`);
    if (unexpectedSafety.length > 0) errors.push(`non-redline ids inside safety: ${unexpectedSafety.join(', ')}`);
  }

  return errors;
}

export function assertValidEvalSplits(
  file: EvalSplitFile,
  expected?: { allCaseIds: string[]; safetyCaseIds: string[] },
): void {
  const errors = validateEvalSplits(file, expected);
  if (errors.length > 0) {
    throw new Error(`Invalid ${EVAL_SPLITS_RELATIVE_PATH}:\n- ${errors.join('\n- ')}`);
  }
}

export async function saveEvalSplits(workingDir: string, file: EvalSplitFile): Promise<void> {
  assertValidEvalSplits(file);
  const target = splitsPath(workingDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(file, null, 2), 'utf-8');
}

export async function loadEvalSplits(workingDir: string): Promise<EvalSplitFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(splitsPath(workingDir), 'utf-8')) as EvalSplitFile;
    assertValidEvalSplits(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
