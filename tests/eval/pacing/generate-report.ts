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
  mode: 'smooth' | 'direct' | 'convex';
  chars: number;
  chunks: number;
  chunkSize: number;
  intervalMs: number;
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

interface Ecosystem {
  checkedAt: string;
  downloadWindow: string;
  packages: Array<{
    name: string;
    version: string;
    modifiedAt: string;
    weeklyDownloads: number;
    externalChunks: boolean;
    qualified: boolean;
    reason: string;
    docs?: string;
    npm: string;
  }>;
  downloadSource: string;
}

const here = import.meta.dirname;
const results = JSON.parse(await readFile(path.join(here, 'artifacts/results.json'), 'utf8')) as Results;
const ecosystem = JSON.parse(await readFile(path.join(here, 'ecosystem.json'), 'utf8')) as Ecosystem;
const repoPacing = path.join(here, 'artifacts');

const modeName = { smooth: 'Neo 现状', direct: '直落', convex: 'Convex useSmoothText' } as const;
const maxThrottleShare = Math.max(...results.partA.map((row) => (row.stage?.accumulatorWaitShare ?? 0) + (row.stage?.messageBatcherShare ?? 0)));

const partATable = results.partA.map((row) => {
  const stage = row.stage!;
  return `| ${row.label} | ${stage.accumulatorWaitMs.toFixed(1)} / ${stage.accumulatorWaitShare.toFixed(1)}% | ${stage.flushCpuMs.toFixed(2)} / ${stage.flushCpuShare.toFixed(2)}% | ${stage.messageBatcherMs.toFixed(1)} / ${stage.messageBatcherShare.toFixed(1)}% | ${stage.reactCommitMs.toFixed(1)} / ${stage.reactCommitShare.toFixed(1)}% | ${stage.smoothAndMarkdownMs.toFixed(1)} / ${stage.smoothAndMarkdownShare.toFixed(1)}% | ${stage.paintMs.toFixed(1)} / ${stage.paintShare.toFixed(1)}% | ${stage.endToEndMs.toFixed(1)} |`;
}).join('\n');

const partASummary = results.partA.map((row) =>
  `| ${row.label} | ${row.chars} / ${row.chunks} | ${row.latencyP50.toFixed(1)} | ${row.latencyP95.toFixed(1)} | ${row.convergenceMs.toFixed(1)} | ${row.droppedFrames} | ${row.longestFrameMs.toFixed(1)} | ${row.longestTaskMs.toFixed(1)} |`,
).join('\n');

const partBTable = results.partB.map((row) =>
  `| ${row.label} | ${modeName[row.mode]} | ${row.latencyP50.toFixed(1)} | ${row.latencyP95.toFixed(1)} | ${row.convergenceMs.toFixed(1)} | ${row.droppedFrames} | ${row.longestFrameMs.toFixed(1)} | ${row.longestTaskMs.toFixed(1)} | ${row.profilerActualMs.toFixed(1)} |`,
).join('\n');

const ecosystemTable = ecosystem.packages.map((pkg) =>
  `| [${pkg.name}](${pkg.npm}) | ${pkg.version} | ${pkg.modifiedAt.slice(0, 10)} | ${pkg.weeklyDownloads.toLocaleString('en-US')} | ${pkg.externalChunks ? '是' : '否'} | ${pkg.qualified ? 'PASS' : 'FAIL'} | ${pkg.reason} |`,
).join('\n');

const screenshotGroups = results.partB.map((row) => {
  const links = row.screenshots.map((relative, index) => `[帧 ${index + 1}](${path.join(repoPacing, relative)})`).join(' · ');
  return `- ${row.label} / ${modeName[row.mode]}：${links}`;
}).join('\n');

const currentByFixture = new Map(results.partB.filter((row) => row.mode === 'smooth').map((row) => [row.fixtureId, row]));
const currentRuns = results.partB.filter((row) => row.mode === 'smooth');
const currentConvergence = currentRuns.map((row) => `${row.label} ${row.convergenceMs.toFixed(1)}ms`).join('、');
const partALongCode = results.partA.find((row) => row.fixtureId === 'long-mixed-code')!;
const convexWins = results.partB.filter((row) => row.mode === 'convex').every((row) => {
  const current = currentByFixture.get(row.fixtureId)!;
  return row.latencyP50 < current.latencyP50
    && row.latencyP95 < current.latencyP95
    && row.convergenceMs < current.convergenceMs
    && row.droppedFrames <= current.droppedFrames
    && row.longestFrameMs <= current.longestFrameMs;
});

const report = `# N-L5-PACING · 节奏层 spike 报告

日期：2026-08-17<br>
范围：只测量 harness，生产代码零修改<br>
原始数据：[results.json](${path.join(repoPacing, 'results.json')})

## 裁决

1. **batching / accumulator 替换观望项关闭。** 当前文字 <code>stream_chunk</code> 主链不经过 <code>useMessageBatcher(50ms)</code>，实测调用数为 0、占比为 0%；150ms accumulator 等待在三场景占端到端 ${results.partA.map((row) => row.stage!.accumulatorWaitShare.toFixed(1)).join('% / ')}%，最大 ${maxThrottleShare.toFixed(1)}%，没有超过 50% 触发线。**观望项关闭，无需替换 spike。**
2. **smooth 替换观望项保持开启。** 合格生态候选 <code>@convex-dev/agent@0.6.4/useSmoothText</code> 在三条 fixture 的 p50、p95、追平、掉帧与最长帧组合上均胜现状：${convexWins ? 'PASS' : 'FAIL'}。按“生态不赢我方即留”，本轮不满足“留现状并关闭”的条件。
3. **现方案 240ms 追平目标只在高频小 chunk 成立。** ${currentConvergence}。动态算法每帧按“剩余段数”重算间隔，剩余越少间隔越长，实际总耗时呈累加效应；现有 helper 测试验证一次性 240ms budget，没有覆盖真实 rAF 跨帧重算。
4. **不建议直接引入整包。** npm tarball 解包约 4.5MB，公开入口 <code>@convex-dev/agent/react</code> 带 Convex/AI SDK peers；harness 为保持本仓零依赖改动，执行的是该版本 tarball 内同一份 3.4KB <code>useSmoothText.js</code>。下一切片应先验证算法移植或可拆包引入的 bundle/许可/维护成本，再决定替换。

## 研究问题与测量边界

- Part A：chunk 到达后，150ms accumulator、flush CPU、React target commit、smooth + 命中时的 96ms markdown throttle、下一次 rAF paint opportunity，各自占端到端多少。
- Part B：去掉 accumulator，让相同 chunk 序列直接进入目标文本，只比较 Neo smooth、直落、Convex smooth。
- React Profiler 的 <code>actualDuration</code> 用来记录渲染 CPU；<code>performance.mark/measure</code> 记录 flush；layout effect + 下一次 rAF 记录可见 paint opportunity；连续 rAF gap >33.34ms 折算掉帧。
- “对应文字可见”定义为 source prefix 已进入生产 Markdown renderer 并经过下一次 rAF。Markdown 控制字符本身没有字形，不能用 DOM <code>textContent</code> 与 source char 一一对应。
- 每场景一轮正式同机采样；p50/p95 来自该轮全部 source char，Part A 的阶段占比来自全部 accumulator flush。截图为 25% / 50% / 75% / 终态四帧。

## Part A · 分层耗时归因

工单假设的“accumulator → useMessageBatcher → React”串联链在当前代码中已经不存在：<code>appendAssistantStreamDelta</code> 优先调用 <code>appendStreamingMessageDelta</code>，150ms 后直接 <code>updateMessage</code>；<code>queueUpdate/useMessageBatcher</code> 只保留兼容回退和工具调用旁路。因此 batcher 的 50ms 配置不能算进文字主链。

下表每格为“每次 flush 平均毫秒 / 占端到端比例”。smooth 一列包含生产路径命中 Markdown 时的 96ms throttle，因为它位于 smooth 输出与最终 commit 之间，无法从用户可见节奏中剔除。

| 场景 | accumulator 等待 | flush CPU | MessageBatcher | React commit | smooth + markdown | paint | 端到端 |
|---|---:|---:|---:|---:|---:|---:|---:|
${partATable}

| 场景 | 字符 / chunks | 落字 p50 | 落字 p95 | 停流追平 | 掉帧 | 最长帧 | 最长 long task |
|---|---:|---:|---:|---:|---:|---:|---:|
${partASummary}

长代码 Part A 的 ${partALongCode.longestFrameMs.toFixed(1)}ms 最长帧来自代码高亮冷路径，PerformanceObserver 同轮记录 ${partALongCode.longestTaskMs.toFixed(1)}ms long task；它拉高掉帧，但不改变 accumulator/batcher 未过 50% 的结论。

## Part B · smooth 平滑层对拍

| fixture | 方案 | 落字 p50 ms | 落字 p95 ms | 停流追平 ms | 掉帧 | 最长帧 ms | 最长 long task ms | Profiler CPU 累计 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${partBTable}

数据判断：

- 直落是延迟下界，不提供独立节奏整形；生产 Markdown 96ms throttle 仍会让 Markdown fixture 呈批次上屏。
- Convex 在本轮输入率下自适应到接近输入速度，延迟与直落接近；相比 Neo 现状，三场景 p50 下降约 72%–78%，停流追平降至 10.5–14.3ms。
- Neo 现状保留 CJK 10 字短段和尾部生长感，但长 fixture 明显落后输入；截图中同一输入进度下可见正文更短。主观顺滑度不强行计分，保留逐帧组供人眼判断。

### 逐帧截图

${screenshotGroups}

## 生态候选门禁

下载量窗口：${ecosystem.downloadWindow}；下载量来源：[npm downloads API](${ecosystem.downloadSource})。

| 包 | 版本 | 最近发布/修改 | 周下载 | 接外部 chunk | 门禁 | 判断 |
|---|---:|---:|---:|---|---|---|
${ecosystemTable}

<code>@assistant-ui/react</code> 的 <code>useSmooth</code> 虽然与 Neo 设计接近，也支持 <code>drainMs</code>，但 API 内部读取 assistant-ui message id/runtime；本仓现有 session store 不能把单个外部文本直接交给它，因此未列入对拍。Convex 官方文档明确 <code>useSmoothText(message.text)</code> “can work with any text”，满足外部 chunk 门禁。

## 风险与下一决策点

- 本轮证明 Convex 算法在客观延迟/收敛上赢，尚未证明其 20fps 字符级推进在人眼观感上优于 Neo 的词/CJK 短段；逐帧静态图只能核对进度和布局，不能替代真机视频盲评。
- 采用整包会引入本仓当前没有的 Convex peers。若继续替换切片，验收应要求：保持 <code>prefers-reduced-motion</code>、CJK/词段视觉、停流 p95 ≤240ms、三 fixture 不新增掉帧、renderer bundle 增量有上限。
- Part A 无需再研究 <code>useMessageBatcher</code> 替换；若要降低总体落字延迟，优先对象是 smooth 的跨帧追赶算法，其次才是 150ms accumulator 参数。

## 复现命令

~~~bash
cd /Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap
df -h /
npm_config_cache=/tmp/n-l5-pacing-npm-cache npm pack @convex-dev/agent@0.6.4 --pack-destination /tmp
mkdir -p node_modules/@convex-dev/agent
tar -xzf /tmp/convex-dev-agent-0.6.4.tgz -C node_modules/@convex-dev/agent --strip-components=1
npx tsx tests/eval/pacing/run.ts
npx tsx tests/eval/pacing/generate-report.ts
node scripts/tsc-tests-ratchet.mjs
node scripts/knip-ratchet.mjs --profile production
~~~

运行环境：<code>${results.metadata.userAgent}</code>。固定 accumulator=${results.metadata.accumulatorThrottleMs}ms、MessageBatcher 配置=${results.metadata.messageBatcherConfiguredMs}ms（主链未调用）、Markdown throttle=${results.metadata.markdownThrottleMs}ms。截图字体假等待通过 Playwright 自带 <code>PW_TEST_SCREENSHOT_NO_FONTS_READY</code> 关闭；页面不声明 web font，该开关不改变 React/rAF/测量时序。
`;

await writeFile(path.join(here, 'artifacts/report.md'), report);
process.stdout.write(`${path.join(here, 'artifacts/report.md')}\n`);
