// ============================================================================
// Eval Dataset Name - 实验名归一为数据集名（评测中心基准 tab 分组/对比口径）
//
// 背景：experiments 表 name 落盘时带日期/时间戳（src/host/evaluation/experimentAdapter.ts）：
//   - test-runner:  eval-2026-07-21 / eval-<dataset>-2026-07-21 / harness-<variant>-2026-07-21
//   - eval-harness: eval-harness-2026-07-21 / eval-harness-<dataset>-2026-07-21
//   - regression:   regression-2026-07-21
//   - swe-bench 导入: runDir 名，如 2026-04-28-django__django-16642-judge-v1（日期前缀）
// 同一数据集的多次跑分因此被当成不同实验；跨数据集混跑时「最近两次对比」会跨数据集。
// 这里剥掉日期/时间戳片段得到数据集名，分组与对比都按归一名进行（同一归一名下
// 按时间倒序取最近两次）。
// ============================================================================

import type { EvalExperimentListItem } from '@shared/contract/evaluation';

// ISO 日期（可带时间）：2026-07-21 / 2026-07-21T153000 / 2026-07-21_15-30-00
const ISO_DATE = '\\d{4}-\\d{2}-\\d{2}(?:[T_ ](?:\\d{2}[:.-]?\\d{2}(?:[:.-]\\d{2})?|\\d{6}))?';
const DATE_PREFIX_RE = new RegExp(`^${ISO_DATE}[-_ ]`);
const DATE_SUFFIX_RE = new RegExp(`[-_ ]${ISO_DATE}$`);
// 紧凑日期/时间戳：20260721 / 20260721-153000 / 20260721_153000
const COMPACT_SUFFIX_RE = /[-_ ]\d{8}(?:[T_-]?\d{6})?$/;
// epoch 毫秒（13 位）：exp-1719931200000
const EPOCH_MS_SUFFIX_RE = /[-_ ]\d{13}$/;

/**
 * 把带日期/时间戳前后缀的实验名归一为数据集名。
 * 剥完为空（name 本身就是日期）时返回原始 name，保证分组 key 稳定。
 */
export function normalizeDatasetName(name: string): string {
  let normalized = name.trim();
  normalized = normalized.replace(DATE_PREFIX_RE, '');
  normalized = normalized.replace(DATE_SUFFIX_RE, '');
  normalized = normalized.replace(COMPACT_SUFFIX_RE, '');
  normalized = normalized.replace(EPOCH_MS_SUFFIX_RE, '');
  return normalized || name;
}

export interface EvalDatasetGroup {
  /** 分组 key：`${source}::${dataset}`（同名数据集跨 source 不合并）。 */
  key: string;
  source: string;
  /** 归一后的数据集名。 */
  dataset: string;
  /** 时间倒序。 */
  runs: EvalExperimentListItem[];
}

/**
 * 按「source + 归一数据集名」分组；组内按时间倒序，组间按最新运行时间倒序。
 */
export function groupExperimentsByDataset(experiments: EvalExperimentListItem[]): EvalDatasetGroup[] {
  const byKey = new Map<string, EvalDatasetGroup>();
  for (const experiment of experiments) {
    const dataset = normalizeDatasetName(experiment.name);
    const key = `${experiment.source}::${dataset}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, source: experiment.source, dataset, runs: [] };
      byKey.set(key, group);
    }
    group.runs.push(experiment);
  }
  const groups = Array.from(byKey.values());
  for (const group of groups) {
    group.runs.sort((a, b) => b.timestamp - a.timestamp);
  }
  groups.sort((a, b) => (b.runs[0]?.timestamp ?? 0) - (a.runs[0]?.timestamp ?? 0));
  return groups;
}
