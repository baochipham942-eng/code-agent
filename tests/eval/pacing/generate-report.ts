import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Stage {
  accumulatorWaitMs: number;
  accumulatorWaitShare: number;
  flushCpuMs: number;
  flushCpuShare: number;
  messageBatcherMs: number;
  messageBatcherShare: number;
  reactCommitMs: number;
  reactCommitShare: number;
  smoothAndMarkdownMs: number;
  smoothAndMarkdownShare: number;
  paintMs: number;
  paintShare: number;
  endToEndMs: number;
}

interface RunRow {
  fixtureId: string;
  label: string;
  mode: 'smooth' | 'direct';
  chars: number;
  chunks: number;
  latencyP50: number;
  latencyP95: number;
  convergenceMs: number;
  droppedFrames: number;
  longestFrameMs: number;
  longestTaskMs: number;
  profilerActualMs: number;
  flushCount: number;
  batcherTextPathCalls: number;
  stage?: Stage;
  screenshots: string[];
}

interface Results {
  metadata: {
    generatedAt: string;
    userAgent: string;
    accumulatorThrottleMs: number;
    messageBatcherConfiguredMs: number;
    markdownThrottleMs: number;
    visibilityDefinition: string;
  };
  partA: RunRow[];
  partB: RunRow[];
}

const here = import.meta.dirname;
const artifactDir = path.join(here, 'artifacts');
const results = JSON.parse(await readFile(path.join(artifactDir, 'results.json'), 'utf8')) as Results;
const modeName = { smooth: 'smooth', direct: 'direct' } as const;

const partATable = results.partA.map((row) => {
  const stage = row.stage!;
  return `| ${row.label} | ${row.chars} / ${row.chunks} | ${row.latencyP50.toFixed(1)} | ${row.latencyP95.toFixed(1)} | ${row.convergenceMs.toFixed(1)} | ${row.droppedFrames} | ${row.longestFrameMs.toFixed(1)} | ${row.longestTaskMs.toFixed(1)} | ${stage.accumulatorWaitMs.toFixed(1)} / ${stage.accumulatorWaitShare.toFixed(1)}% |`;
}).join('\n');

// Part A 的分层归因是这套 harness 的核心产出：它回答「端到端时间花在哪一层」，
// 而不只是「端到端多久」。convex/legacy 对照撤掉时不该连它一起撤（2026-08-18 补回）。
const partAStageTable = results.partA.map((row) => {
  const s = row.stage!;
  return `| ${row.label} | ${s.accumulatorWaitMs.toFixed(1)} / ${s.accumulatorWaitShare.toFixed(1)}% | ${s.flushCpuMs.toFixed(1)} / ${s.flushCpuShare.toFixed(1)}% | ${s.messageBatcherMs.toFixed(1)} / ${s.messageBatcherShare.toFixed(1)}% | ${s.reactCommitMs.toFixed(1)} / ${s.reactCommitShare.toFixed(1)}% | ${s.smoothAndMarkdownMs.toFixed(1)} / ${s.smoothAndMarkdownShare.toFixed(1)}% | ${s.paintMs.toFixed(1)} / ${s.paintShare.toFixed(1)}% | ${s.endToEndMs.toFixed(1)} |`;
}).join('\n');

const partBTable = results.partB.map((row) =>
  `| ${row.label} | ${modeName[row.mode]} | ${row.latencyP50.toFixed(1)} | ${row.latencyP95.toFixed(1)} | ${row.convergenceMs.toFixed(1)} | ${row.droppedFrames} | ${row.longestFrameMs.toFixed(1)} | ${row.longestTaskMs.toFixed(1)} | ${row.profilerActualMs.toFixed(1)} |`,
).join('\n');

const screenshotGroups = results.partB.map((row) => {
  const links = row.screenshots.map((relative, index) => `[帧 ${index + 1}](${path.join(artifactDir, relative)})`).join(' · ');
  return `- ${row.label} / ${modeName[row.mode]}：${links}`;
}).join('\n');

const report = `# Pacing harness 基线

生成时间：${results.metadata.generatedAt}<br>
原始数据：[results.json](${path.join(artifactDir, 'results.json')})

Part A 复刻生产链路：150ms accumulator → React commit → smooth → 命中时的 96ms markdown throttle → rAF paint。Part B 使用相同 chunk 序列，移除 accumulator，仅比较 smooth 与 direct。

## 测量边界

- React Profiler 的 <code>actualDuration</code> 记录渲染 CPU；<code>performance.mark/measure</code> 记录 flush；
  layout effect + 下一次 rAF 记录可见 paint opportunity；连续 rAF gap >33.34ms 折算掉帧。
- 「对应文字可见」= ${results.metadata.visibilityDefinition}。Markdown 控制字符本身没有字形，
  不能用 DOM <code>textContent</code> 与 source char 一一对应。
- 配置基线：accumulator ${results.metadata.accumulatorThrottleMs}ms、
  markdown throttle ${results.metadata.markdownThrottleMs}ms、
  useMessageBatcher 配置值 ${results.metadata.messageBatcherConfiguredMs}ms（文字主链当前不经过它，故实测占比为 0）。

## Part A · 端到端汇总

| 场景 | 字符 / chunks | latency p50 | latency p95 | 停流追平 | 掉帧 | 最长帧 | 最长 long task | accumulator 等待 / 占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${partATable}

## Part A · 分层耗时归因

每格为「每次 flush 平均毫秒 / 占端到端比例」。smooth 一列含生产路径命中 Markdown 时的 throttle
——它位于 smooth 输出与最终 commit 之间，无法从用户可见节奏中剔除。

| 场景 | accumulator 等待 | flush CPU | MessageBatcher | React commit | smooth + markdown | paint | 端到端 |
|---|---:|---:|---:|---:|---:|---:|---:|
${partAStageTable}

## Part B

| 场景 | 模式 | latency p50 | latency p95 | 停流追平 | 掉帧 | 最长帧 | 最长 long task | Profiler CPU 累计 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${partBTable}

## 截图

${screenshotGroups}

运行环境：${results.metadata.userAgent}

固定参数：accumulator=${results.metadata.accumulatorThrottleMs}ms；MessageBatcher 配置=${results.metadata.messageBatcherConfiguredMs}ms（文字主链未调用）；Markdown throttle=${results.metadata.markdownThrottleMs}ms。
`;

await writeFile(path.join(artifactDir, 'report.md'), report);
process.stdout.write(`${path.join(artifactDir, 'report.md')}\n`);
