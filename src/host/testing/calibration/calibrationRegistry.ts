// ============================================================================
// Judge 校准注册表 — llm_judge 分数进可信列的唯一凭据
// ============================================================================
// scoreAuthority 第二步：llm_judge 桶的分数必须绑定一条达标的校准记录
// （judge 与确定性金标的 Cohen's Kappa ≥ substantial 档且配对样本足量）
// 才可作能力证据。记录由 scripts/judge-calibration.ts 的 control 集跑量产生、
// 落盘到注册表；报告层凭 isTrustedCalibration 决定标注「已校准」还是
// 「未校准/未达标——不作能力证据」。
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';

/** 一次 judge 校准的落盘摘要（完整混淆矩阵在 calibration-*.json 原始报告里） */
export interface JudgeCalibrationRecord {
  /** judge 身份：provider/model（同一 judge 换 prompt 版本应视为新 judgeId） */
  judgeId: string;
  /** Cohen's Kappa（去除随机一致后的真实一致度） */
  kappa: number;
  /** 裸一致率 */
  agreementRate: number;
  /** 配对样本数（control 集大小） */
  pairs: number;
  /** 虚高率 FP/(FP+TN)：judge 被讨好的主要失效模式 */
  falsePositiveRate: number;
  /** 计算时间（ISO） */
  computedAt: string;
}

/**
 * 可信阈值：κ≥0.6 = Landis-Koch substantial 档起步；
 * 样本 <20 时 κ 方差过大，不足以背书。
 */
export const CALIBRATION_TRUST_THRESHOLDS = {
  minKappa: 0.6,
  minPairs: 20,
} as const;

export function isTrustedCalibration(record: JudgeCalibrationRecord): boolean {
  return (
    record.kappa >= CALIBRATION_TRUST_THRESHOLDS.minKappa &&
    record.pairs >= CALIBRATION_TRUST_THRESHOLDS.minPairs
  );
}

const REGISTRY_FILE = 'judge-calibration.json';

type Registry = Record<string, JudgeCalibrationRecord>;

async function loadRegistry(dir: string): Promise<Registry> {
  try {
    const raw = await fs.readFile(path.join(dir, REGISTRY_FILE), 'utf-8');
    return JSON.parse(raw) as Registry;
  } catch {
    return {};
  }
}

/** 写入/覆盖一条校准记录（同 judgeId 最新一次为准） */
export async function saveCalibrationRecord(dir: string, record: JudgeCalibrationRecord): Promise<void> {
  const registry = await loadRegistry(dir);
  registry[record.judgeId] = record;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, REGISTRY_FILE), JSON.stringify(registry, null, 2), 'utf-8');
}

/** 按 judgeId 取校准记录；没有 → null（= 未校准） */
export async function loadCalibrationRecord(dir: string, judgeId: string): Promise<JudgeCalibrationRecord | null> {
  const registry = await loadRegistry(dir);
  return registry[judgeId] ?? null;
}
