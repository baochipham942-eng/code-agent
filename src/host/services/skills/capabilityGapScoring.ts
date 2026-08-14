// ============================================================================
// 缺口探测的纯逻辑（N-CAP1 / F1）—— 去参数化 · 信号判别 · 机械分 · 层级路由
// ============================================================================
// 单独一个文件的理由有两个，都不是为了「分层好看」：
//   1. 这些函数全是纯函数，是本单最该被单测钉死的部分（聚类口径、增量打分、
//      三测试），和「读写账本」的有状态部分放一起会互相碍事；
//   2. 有状态那侧（observeTurn / listCandidates）真的要 import 它们，
//      于是它们是被使用的导出，而不是只有测试在用的悬空导出。
//
// 硬约束：**模型产出的字段（displayName / summary）不出现在本文件任何地方。**
// 排序主键必须可复算、可解释、与模型无关。

import { CAPABILITY_CANDIDATES } from '../../../shared/constants';
import type {
  CapabilityCandidateRecord,
  CapabilityCandidateTier,
  CapabilityCandidateTierTests,
} from '../../../shared/contract/capabilityCandidate';
import type { ComboStep } from './comboRecorder';

// ---------------------------------------------------------------------------
// ② 去参数化
// ---------------------------------------------------------------------------

/**
 * 一步 → shape token（去掉全部参数，只留「用了什么」）。
 *
 * bash 单独细分到 argv0：拼凑几乎都是 bash 驱动的，只记 "bash" 会把
 * `screencapture` 和 `ffmpeg` 归成同一簇，聚类立刻失去判别力。
 */
function shapeOfStep(step: Pick<ComboStep, 'toolName' | 'args'>): string {
  const toolName = (step.toolName || 'unknown').trim();
  if (!isShellTool(toolName)) return toolName;

  const command = firstStringArg(step.args, ['command', 'cmd', 'script']);
  const head = commandHead(command);
  return head ? `${toolName}:${head}` : toolName;
}

function isShellTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === 'bash' || lower === 'shell' || lower === 'run_command';
}

function firstStringArg(args: Record<string, unknown> | undefined, keys: string[]): string {
  if (!args) return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * 取命令的可执行名：丢掉 env 前缀、路径、参数与引号。
 * `HTTPS_PROXY=x /usr/bin/ffmpeg -i a.mp4` → `ffmpeg`
 */
function commandHead(command: string): string {
  const firstSegment = command.split(/[|;&\n]/)[0] ?? '';
  for (const rawToken of firstSegment.trim().split(/\s+/)) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    if (!token) continue;
    // `KEY=value` 形式的环境变量前缀不是可执行名
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    // 选项（-v / --version）永远不是可执行名。真库回放里 `command -v foo`
    // 曾被解析成 `-v`，说明这一条不是理论问题。
    if (token.startsWith('-')) continue;
    // shell 语法词与「这东西存在吗」的探针动词：真正要记的是它们的宾语。
    // 这不是「哪些命令算外部」的名字清单，是 shell 语法处理。
    if (SHELL_WRAPPER_WORDS.has(token)) continue;
    const base = token.split('/').pop() ?? token;
    if (base) return base.toLowerCase();
  }
  return '';
}

const SHELL_WRAPPER_WORDS = new Set(['sudo', 'env', 'command', 'which', 'type', 'exec', 'nohup', 'time']);

/** 一轮的步骤顺序（去参数化 + 去掉连续重复），用于算变异度 */
export function sequenceShapeOf(steps: Array<Pick<ComboStep, 'toolName' | 'args'>>): string[] {
  const shapes: string[] = [];
  for (const step of steps) {
    const shape = shapeOfStep(step);
    if (shapes[shapes.length - 1] !== shape) shapes.push(shape);
  }
  return shapes;
}

/**
 * 意图簇键 = 去重排序后的 shape token 集合。
 *
 * 为什么是「集合」而不是「序列」：序列做键会把同一件事的不同做法切成好几簇，
 * 分数被摊薄；而簇内保留各条序列，正好给出可参数化度（变异度倒数）。
 * 列表要展示的「凭什么把这几次归成一条」，就是这个集合本身。
 */
export function clusterKeyOf(shapeSequence: string[]): string {
  return [...new Set(shapeSequence)].sort().join(' + ');
}

/** 两个工具集合的重合度（Jaccard）：列表里「凭什么归成一条」的第二种答案 */
function toolSetOverlap(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 找这一轮该归到哪个已有候选。
 *
 * 为什么不能只用精确的集合键：真库回放实测，同一件事（建目录→装依赖→跑脚本）
 * 每次多一两个工具就变成一个新键，200 条候选里绝大多数 occurrences=1，
 * 真正反复在做的事反而永远攒不出分数。所以精确键不中就退一步按重合度归并。
 * 归并**不吸收**新工具（簇的代表集合保持首次那份），否则簇会一路漂移成大杂烩。
 */
export function findClusterFor(
  shapeTokens: string[],
  existing: Array<{ clusterKey: string; shapeTokens: string[] }>,
): string | null {
  const exactKey = shapeTokens.slice().sort().join(' + ');
  if (existing.some((entry) => entry.clusterKey === exactKey)) return exactKey;

  let best: { key: string; overlap: number } | null = null;
  for (const entry of existing) {
    const overlap = toolSetOverlap(shapeTokens, entry.shapeTokens);
    if (overlap >= CAPABILITY_CANDIDATES.CLUSTER_MERGE_OVERLAP && (!best || overlap > best.overlap)) {
      best = { key: entry.clusterKey, overlap };
    }
  }
  return best?.key ?? null;
}

/**
 * 这一簇是不是「拼凑」——首屏的必要条件。
 *
 * 判据：簇里得有 shell 步骤。Bash 是工具表里**没有对应工具时的唯一出口**，
 * 所以「反复走 Bash 出口」正是缺口的可观测签名；而纯内置工具的组合
 * （Read/Write/Edit/WebSearch…）是 agent 干活的正常方式，不是缺口。
 * 真库回放实测：不加这一条，首屏第一名是「WebSearch ×114」——
 * 那不是它缺什么，那是它有这个工具而且很常用。
 * 纯工具编排仍然记账、仍可展开看，只是不占首屏。
 */
export function hasWorkaroundSignature(shapeTokens: string[]): boolean {
  return shapeTokens.some((token) => token.includes(':'));
}

// ---------------------------------------------------------------------------
// ① 信号采集
// ---------------------------------------------------------------------------

/** S3：错误文本里「因为没有 X」的形态。命中即判「要现有工具集之外的东西」。 */
const MISSING_DEPENDENCY_PATTERNS: RegExp[] = [
  /command not found/i,
  /no such file or directory/i,
  /not (?:installed|available|supported|recognized)/i,
  /is unavailable/i,
  /unknown (?:tool|command)/i,
  /未安装|不可用|找不到命令|不支持该操作/,
];

export function detectMissingHint(step: Pick<ComboStep, 'success' | 'outputPreview'>): string | null {
  if (step.success) return null;
  const text = step.outputPreview ?? '';
  for (const pattern of MISSING_DEPENDENCY_PATTERNS) {
    if (pattern.test(text)) return text.trim().slice(0, 120);
  }
  return null;
}

/** S2：某步失败后换了另一种工具并成功 —— 产物打折但还是交付了 */
export function detectDegraded(steps: Array<Pick<ComboStep, 'success' | 'toolName' | 'args'>>): boolean {
  const failedIndex = steps.findIndex((step) => !step.success);
  if (failedIndex < 0) return false;
  const failedShape = shapeOfStep(steps[failedIndex]);
  return steps
    .slice(failedIndex + 1)
    .some((step) => step.success && shapeOfStep(step) !== failedShape);
}

// ---------------------------------------------------------------------------
// ③ 机械分
// ---------------------------------------------------------------------------

/** 时间衰减后的重复度：读时与写时用同一个函数，保证列表与账本口径一致 */
export function decayCount(count: number, elapsedMs: number): number {
  if (!(count > 0)) return 0;
  if (!(elapsedMs > 0)) return count;
  return count * Math.pow(0.5, elapsedMs / CAPABILITY_CANDIDATES.DECAY_HALF_LIFE_MS);
}

/** 单次成本：步数 × token（拿不到用量时退化为纯步数，不假装有数据） */
function unitCostOf(avgSteps: number, avgTokens: number): number {
  const tokenFactor = avgTokens > 0 ? avgTokens / 1000 : 1;
  return Math.max(avgSteps, 1) * Math.max(tokenFactor, 1);
}

/** 可参数化度 = 变异度倒数：只有一种步骤顺序 ⇒ 1（最可参数化） */
function parameterizabilityOf(variantCount: number): number {
  return 1 / Math.max(variantCount, 1);
}

/**
 * 机械分（排序主键）。**模型分不出现在这个函数里，这是硬约束。**
 * 传入 now 以便读时把衰减算进去（久未复现自动下沉，不需要跑批任务）。
 */
export function mechanicalScoreOf(record: CapabilityCandidateRecord, now: number): number {
  const decayed = decayCount(record.decayedCount, now - record.lastSeenAt);
  return decayed
    * unitCostOf(record.avgSteps, record.avgTokens)
    * parameterizabilityOf(record.variants.length);
}

// ---------------------------------------------------------------------------
// 沉淀层级路由 · 三测试
// ---------------------------------------------------------------------------

export function runTierTests(record: Omit<CapabilityCandidateRecord, 'tests' | 'tier'>): CapabilityCandidateTierTests {
  const variance = record.variants.length / Math.max(record.occurrences, 1);
  return {
    deterministic: variance <= CAPABILITY_CANDIDATES.DETERMINISTIC_VARIANCE_MAX,
    // 边界靠证据（S3 真的报了「没有 X」），不靠「哪些命令算外部」的名字清单——
    // 按名字枚举的清单会静默漏掉没列进去的东西。
    needsExternal: record.signals.missingDependency,
    faultProne: record.failureRate > CAPABILITY_CANDIDATES.FAULT_PRONE_FAILURE_RATE,
  };
}

export function tierOf(tests: CapabilityCandidateTierTests): CapabilityCandidateTier {
  if (tests.needsExternal || tests.faultProne) return 'plugin';
  return tests.deterministic ? 'workflow' : 'skill';
}
