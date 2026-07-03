// ============================================================================
// WP1b 样本工程 — 评测噪声带（实测 run-to-run 方差 → 回归门带宽）
// ============================================================================
// baselineManager 原固定 maxScoreDrop=0.15 是拍脑袋值：比真实噪声宽会漏报
// 回归，比噪声窄会假警报逼人无视门。sweep（同子集同配置重复 K 跑，
// scripts/eval-noise-sweep.ts）测出 avgScore 的样本 σ，
// maxScoreDrop = clamp(2σ, floor, cap) 落盘本文件；compare 优先读它。
// floor 防零方差把门焊死；cap 防"噪声大到离谱"被当成理由放宽门——
// 触 cap 应该修 eval（拆 flaky case）而不是接受一个形同虚设的门。
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../config/configPaths';

export const NOISE_BAND_LIMITS = {
  /** 带宽下限：零/极低方差时保留最小容差 */
  floor: 0.05,
  /** 带宽上限：超过说明 eval 本身不稳，该修 case 不该放宽门 */
  cap: 0.3,
  /** 带宽 = sigmaMultiplier × σ（2σ ≈ 95% 单侧容差） */
  sigmaMultiplier: 2,
  /** σ 至少要 3 个样本才勉强可信 */
  minRuns: 3,
} as const;

export interface NoiseBandFile {
  version: 1;
  /** sweep 重复次数 */
  runs: number;
  /** 每次 run 的 avgScore（能力分母口径，infra_excluded 已排除） */
  avgScores: number[];
  /** 样本标准差（n-1） */
  stdDev: number;
  /** 实测带宽：clamp(2σ, floor, cap)，compare 的 maxScoreDrop 用它 */
  maxScoreDrop: number;
  computedAt: string;
  model?: string;
  /** 状态在 K 跑间翻转的 case（翻转率 = 相邻两跑状态不同次数/runs），修 flaky 的线索 */
  caseFlipRates?: Record<string, number>;
}

export function computeNoiseBand(
  avgScores: number[],
  caseStatusRuns?: Record<string, string[]>,
): Pick<NoiseBandFile, 'stdDev' | 'maxScoreDrop' | 'caseFlipRates'> {
  if (avgScores.length < NOISE_BAND_LIMITS.minRuns) {
    throw new Error(`噪声带至少需要 ${NOISE_BAND_LIMITS.minRuns} 个 runs 样本，收到 ${avgScores.length}`);
  }
  const mean = avgScores.reduce((s, v) => s + v, 0) / avgScores.length;
  const variance = avgScores.reduce((s, v) => s + (v - mean) ** 2, 0) / (avgScores.length - 1);
  const stdDev = Math.sqrt(variance);
  const raw = NOISE_BAND_LIMITS.sigmaMultiplier * stdDev;
  const maxScoreDrop = Math.min(NOISE_BAND_LIMITS.cap, Math.max(NOISE_BAND_LIMITS.floor, raw));

  let caseFlipRates: Record<string, number> | undefined;
  if (caseStatusRuns) {
    caseFlipRates = {};
    for (const [caseId, statuses] of Object.entries(caseStatusRuns)) {
      if (statuses.length < 2) continue;
      // 翻转 = 相邻两跑状态不同的次数；率按 runs 数归一
      const flips = statuses.filter((s, i) => i > 0 && s !== statuses[i - 1]).length;
      if (flips > 0) caseFlipRates[caseId] = flips / statuses.length;
    }
  }

  return { stdDev, maxScoreDrop, caseFlipRates };
}

const NOISE_BAND_FILE = 'eval-noise-band.json';

function noiseBandPath(workingDir: string): string {
  const base = path.basename(workingDir) === CONFIG_DIR_NEW ? workingDir : path.join(workingDir, CONFIG_DIR_NEW);
  return path.join(base, NOISE_BAND_FILE);
}

export async function saveNoiseBand(workingDir: string, file: NoiseBandFile): Promise<void> {
  const target = noiseBandPath(workingDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(file, null, 2), 'utf-8');
}

export async function loadNoiseBand(workingDir: string): Promise<NoiseBandFile | null> {
  try {
    return JSON.parse(await fs.readFile(noiseBandPath(workingDir), 'utf-8')) as NoiseBandFile;
  } catch {
    return null;
  }
}
