/**
 * 发版证据登记表 —— 单一真值源。
 *
 * 在此之前，「哪些脚本产出发版证据」这份知识被抄在四处（校验器里三处硬编码字符串、
 * release.yml 的 artifact 清单、release-evidence-gate.yml 的两份 paths、
 * 以及守门测试里自己维护的一张表）。四处互相不认识，新增第四个证据门时必漏一处。
 *
 * 规矩：
 * 1. 新增/删除证据产出脚本，只改这一个文件；消费方全部从这里派生。
 * 2. `scripts/ci/check-release-evidence-registry.ts` 反向扫全仓脚本，
 *    发现产出 docs/{perf,stability,evidence}/*.json 却没登记的路径就报红。
 *    所以「忘了登记」不是靠下一个人记得，是门照出来。
 * 3. 不是发版证据、但确实写进这几个目录的产出，登记到
 *    NON_RELEASE_EVIDENCE_OUTPUTS，让反向扫描有完整账目可对。
 */

interface EvidenceProducerBase {
  /** 证据文件，仓库相对路径 */
  evidence: string;
  /** 产出脚本，仓库相对路径 */
  producer: string;
}

export interface LongSessionEvidence extends EvidenceProducerBase {
  shape: 'long-session';
}

export interface StopEvidence extends EvidenceProducerBase {
  shape: 'stop';
  /** 报告里的 smoke id */
  smoke: string;
  /** 报告必须覆盖的场景 */
  scenarios: readonly string[];
}

export type ReleaseEvidenceProducer = LongSessionEvidence | StopEvidence;

/** 发版闸校验、release.yml 冻结 artifact 的那几份证据 */
export const RELEASE_EVIDENCE_PRODUCERS: readonly ReleaseEvidenceProducer[] = [
  {
    shape: 'long-session',
    evidence: 'docs/perf/long-session-gold-latest.json',
    producer: 'scripts/perf/long-session-browser-smoke.ts',
  },
  {
    shape: 'stop',
    evidence: 'docs/stability/tool-cancel-smoke-latest.json',
    producer: 'scripts/acceptance/tool-cancel-smoke.ts',
    smoke: 'tool-cancel',
    scenarios: ['Bash', 'http_request'],
  },
  {
    shape: 'stop',
    evidence: 'docs/stability/agent-runtime-app-host-smoke-latest.json',
    producer: 'scripts/acceptance/agent-runtime-app-host-smoke.ts',
    smoke: 'agent-runtime-app-host',
    scenarios: ['RunRegistry', 'rendererStop'],
  },
];

export interface AcknowledgedOutput {
  evidence: string;
  producer: string;
  /** 为什么它不是发版证据 */
  reason: string;
}

/**
 * 写进证据目录但不进发版闸的产出。登记在这里只为让反向扫描有完整账目——
 * 不登记就报红，登记了就说清楚为什么不是证据。
 */
export const NON_RELEASE_EVIDENCE_OUTPUTS: readonly AcknowledgedOutput[] = [
  {
    evidence: 'docs/perf/chat-render-browser-latest.json',
    producer: 'scripts/perf/chat-render-browser-smoke.ts',
    reason: '渲染性能本地基准，不入发版 artifact，也没有新鲜度闸',
  },
  {
    evidence: 'docs/perf/diff-render-browser-latest.json',
    producer: 'scripts/perf/diff-render-browser-smoke.ts',
    reason: '渲染性能本地基准，不入发版 artifact，也没有新鲜度闸',
  },
  {
    evidence: 'docs/perf/code-highlight-browser-latest.json',
    producer: 'scripts/perf/code-highlight-browser-smoke.ts',
    reason: '渲染性能本地基准，不入发版 artifact，也没有新鲜度闸',
  },
];

/** 反向扫描的范围。扫不到任何文件要报红，不能静默通过 */
export const EVIDENCE_SCAN = {
  roots: ['scripts'],
  extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'],
  evidenceDirs: ['docs/perf', 'docs/stability', 'docs/evidence'],
} as const;

export const RELEASE_EVIDENCE_GATE_WORKFLOW = '.github/workflows/release-evidence-gate.yml';
export const RELEASE_WORKFLOW = '.github/workflows/release.yml';

/** 生成块的边界标记，`--write` 与一致性门都按它定位 */
export const GENERATED_PATHS_BEGIN = '# BEGIN generated-paths (scripts/lib/releaseEvidenceRegistry.ts)';
export const GENERATED_PATHS_END = '# END generated-paths';

/**
 * release-evidence-gate.yml 的 paths。
 *
 * 用扫描范围本身（`scripts/**`）而不是逐个列产出脚本：证据门要在**新增**未登记脚本时
 * 就触发，逐个枚举的清单永远追不上还没被写出来的那个文件。顺带把「产出脚本 +
 * 共享依赖 + 校验器」三类枚举一并消掉——它们全在 scripts/ 下。
 */
export function releaseEvidenceGatePaths(): string[] {
  return [...EVIDENCE_SCAN.roots.map((root) => `${root}/**`), RELEASE_EVIDENCE_GATE_WORKFLOW];
}

/** 登记表里所有已知产出路径（发版证据 + 已认领的非证据产出） */
export function registeredEvidencePaths(): string[] {
  return [
    ...RELEASE_EVIDENCE_PRODUCERS.map((entry) => entry.evidence),
    ...NON_RELEASE_EVIDENCE_OUTPUTS.map((entry) => entry.evidence),
  ];
}
