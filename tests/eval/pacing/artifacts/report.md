# N-L5-PACING · 节奏层 spike 报告

日期：2026-08-17<br>
范围：只测量 harness，生产代码零修改<br>
原始数据：[results.json](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/results.json)

## 裁决

1. **batching / accumulator 替换观望项关闭。** 当前文字 <code>stream_chunk</code> 主链不经过 <code>useMessageBatcher(50ms)</code>，实测调用数为 0、占比为 0%；150ms accumulator 等待在三场景占端到端 38.4% / 36.3% / 37.6%，最大 38.4%，没有超过 50% 触发线。**观望项关闭，无需替换 spike。**
2. **smooth 替换观望项保持开启。** 合格生态候选 <code>@convex-dev/agent@0.6.4/useSmoothText</code> 在三条 fixture 的 p50、p95、追平、掉帧与最长帧组合上均胜现状：PASS。按“生态不赢我方即留”，本轮不满足“留现状并关闭”的条件。
3. **现方案 240ms 追平目标只在高频小 chunk 成立。** 长代码流式 751.8ms、长散文 633.6ms、高频小 chunk（5 字符/30ms） 194.2ms。动态算法每帧按“剩余段数”重算间隔，剩余越少间隔越长，实际总耗时呈累加效应；现有 helper 测试验证一次性 240ms budget，没有覆盖真实 rAF 跨帧重算。
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
| 长代码流式 | 151.3 / 38.4% | 0.03 / 0.01% | 0.0 / 0.0% | 0.6 / 0.2% | 242.4 / 61.6% | 2.5 / 0.6% | 393.7 |
| 长散文 | 151.2 / 36.3% | 0.05 / 0.01% | 0.0 / 0.0% | 0.2 / 0.1% | 257.9 / 61.9% | 7.4 / 1.8% | 416.8 |
| 高频小 chunk（5 字符/30ms） | 151.0 / 37.6% | 0.06 / 0.01% | 0.0 / 0.0% | 0.6 / 0.1% | 243.4 / 60.6% | 6.8 / 1.7% | 401.3 |

| 场景 | 字符 / chunks | 落字 p50 | 落字 p95 | 停流追平 | 掉帧 | 最长帧 | 最长 long task |
|---|---:|---:|---:|---:|---:|---:|---:|
| 长代码流式 | 6912 / 173 | 279.4 | 347.8 | 643.2 | 18 | 299.1 | 305.0 |
| 长散文 | 2377 / 60 | 275.8 | 374.5 | 649.2 | 0 | 17.7 | 0.0 |
| 高频小 chunk（5 字符/30ms） | 717 / 144 | 258.5 | 350.4 | 174.8 | 0 | 18.7 | 0.0 |

长代码 Part A 的 299.1ms 最长帧来自代码高亮冷路径，PerformanceObserver 同轮记录 305.0ms long task；它拉高掉帧，但不改变 accumulator/batcher 未过 50% 的结论。

## Part B · smooth 平滑层对拍

| fixture | 方案 | 落字 p50 ms | 落字 p95 ms | 停流追平 ms | 掉帧 | 最长帧 ms | 最长 long task ms | Profiler CPU 累计 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 长代码流式 | Neo 现状 | 231.2 | 303.0 | 751.8 | 1 | 33.4 | 0.0 | 371.2 |
| 长代码流式 | 直落 | 54.3 | 98.8 | 11.4 | 0 | 18.8 | 0.0 | 285.8 |
| 长代码流式 | Convex useSmoothText | 61.5 | 104.6 | 14.3 | 0 | 18.7 | 0.0 | 311.3 |
| 长散文 | Neo 现状 | 236.6 | 347.9 | 633.6 | 0 | 18.7 | 0.0 | 79.6 |
| 长散文 | 直落 | 64.8 | 102.4 | 7.6 | 0 | 18.8 | 0.0 | 51.4 |
| 长散文 | Convex useSmoothText | 65.8 | 109.4 | 12.3 | 0 | 18.7 | 0.0 | 50.1 |
| 高频小 chunk（5 字符/30ms） | Neo 现状 | 247.7 | 402.8 | 194.2 | 0 | 18.7 | 0.0 | 158.4 |
| 高频小 chunk（5 字符/30ms） | 直落 | 54.8 | 104.3 | 11.1 | 0 | 18.7 | 0.0 | 160.9 |
| 高频小 chunk（5 字符/30ms） | Convex useSmoothText | 55.1 | 101.3 | 10.5 | 0 | 18.7 | 0.0 | 208.8 |

数据判断：

- 直落是延迟下界，不提供独立节奏整形；生产 Markdown 96ms throttle 仍会让 Markdown fixture 呈批次上屏。
- Convex 在本轮输入率下自适应到接近输入速度，延迟与直落接近；相比 Neo 现状，三场景 p50 下降约 72%–78%，停流追平降至 10.5–14.3ms。
- Neo 现状保留 CJK 10 字短段和尾部生长感，但长 fixture 明显落后输入；截图中同一输入进度下可见正文更短。主观顺滑度不强行计分，保留逐帧组供人眼判断。

### 逐帧截图

- 长代码流式 / Neo 现状：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-4.png)
- 长代码流式 / 直落：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-4.png)
- 长代码流式 / Convex useSmoothText：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-convex-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-convex-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-convex-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-code-convex-frame-4.png)
- 长散文 / Neo 现状：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-4.png)
- 长散文 / 直落：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-4.png)
- 长散文 / Convex useSmoothText：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-convex-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-convex-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-convex-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-convex-frame-4.png)
- 高频小 chunk（5 字符/30ms） / Neo 现状：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-4.png)
- 高频小 chunk（5 字符/30ms） / 直落：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-4.png)
- 高频小 chunk（5 字符/30ms） / Convex useSmoothText：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-convex-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-convex-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-convex-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/l5-mdswap/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-convex-frame-4.png)

## 生态候选门禁

下载量窗口：2026-08-09..2026-08-15；下载量来源：[npm downloads API](https://api.npmjs.org/downloads/point/last-week/{package})。

| 包 | 版本 | 最近发布/修改 | 周下载 | 接外部 chunk | 门禁 | 判断 |
|---|---:|---:|---:|---|---|---|
| [@convex-dev/agent](https://www.npmjs.com/package/@convex-dev/agent) | 0.6.4 | 2026-08-13 | 117,816 | 是 | PASS | 公开 useSmoothText(text, options) 接受任意持续增长文本；近 6 个月维护且下载量足够。 |
| [@assistant-ui/react](https://www.npmjs.com/package/@assistant-ui/react) | 0.15.14 | 2026-08-12 | 1,446,383 | 否 | FAIL | 维护和下载合格，但 useSmooth 依赖 assistant-ui message/runtime context；现有 session store 的外部 chunk 不能低侵入直连。 |
| [@nvq/flowtoken](https://www.npmjs.com/package/@nvq/flowtoken) | 2.0.6 | 2025-08-07 | 344 | 是 | FAIL | 定位匹配，但超过 12 个月未发布且下载量低，不满足维护门槛。 |
| [react-type-animation](https://www.npmjs.com/package/react-type-animation) | 3.2.0 | 2023-10-10 | 236,066 | 否 | FAIL | 下载量足够，但三年未发布；组件永久 memo，文档明确 props 更新不会反映，不适合外部 chunk 流。 |

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

运行环境：<code>Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.7778.96 Safari/537.36</code>。固定 accumulator=150ms、MessageBatcher 配置=50ms（主链未调用）、Markdown throttle=96ms。截图字体假等待通过 Playwright 自带 <code>PW_TEST_SCREENSHOT_NO_FONTS_READY</code> 关闭；页面不声明 web font，该开关不改变 React/rAF/测量时序。
