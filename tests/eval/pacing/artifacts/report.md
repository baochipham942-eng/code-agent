# Pacing harness 基线

生成时间：2026-08-17T18:18:43.266Z<br>
原始数据：[results.json](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/results.json)

Part A 复刻生产链路：150ms accumulator → React commit → smooth → 命中时的 96ms markdown throttle → rAF paint。Part B 使用相同 chunk 序列，移除 accumulator，仅比较 smooth 与 direct。

## 测量边界

- React Profiler 的 <code>actualDuration</code> 记录渲染 CPU；<code>performance.mark/measure</code> 记录 flush；
  layout effect + 下一次 rAF 记录可见 paint opportunity；连续 rAF gap >33.34ms 折算掉帧。
- 「对应文字可见」= source prefix admitted to the production Markdown renderer and followed by a requestAnimationFrame paint opportunity。Markdown 控制字符本身没有字形，
  不能用 DOM <code>textContent</code> 与 source char 一一对应。
- 配置基线：accumulator 150ms、
  markdown throttle 96ms、
  useMessageBatcher 配置值 50ms（文字主链当前不经过它，故实测占比为 0）。

## Part A · 端到端汇总

| 场景 | 字符 / chunks | latency p50 | latency p95 | 停流追平 | 掉帧 | 最长帧 | 最长 long task | accumulator 等待 / 占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 长代码流式 | 6912 / 173 | 253.6 | 308.3 | 222.9 | 1 | 35.2 | 0.0 | 151.3 / 40.7% |
| 长散文 | 2377 / 60 | 255.1 | 320.0 | 159.8 | 0 | 18.6 | 0.0 | 152.1 / 41.2% |
| 高频小 chunk（5 字符/30ms） | 717 / 144 | 219.0 | 264.5 | 114.5 | 0 | 18.7 | 0.0 | 150.9 / 43.6% |

## Part A · 分层耗时归因

每格为「每次 flush 平均毫秒 / 占端到端比例」。smooth 一列含生产路径命中 Markdown 时的 throttle
——它位于 smooth 输出与最终 commit 之间，无法从用户可见节奏中剔除。

| 场景 | accumulator 等待 | flush CPU | MessageBatcher | React commit | smooth + markdown | paint | 端到端 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 长代码流式 | 151.3 / 40.7% | 0.0 / 0.0% | 0.0 / 0.0% | 0.4 / 0.1% | 216.4 / 58.3% | 4.1 / 1.1% | 371.3 |
| 长散文 | 152.1 / 41.2% | 0.0 / 0.0% | 0.0 / 0.0% | 0.4 / 0.1% | 210.1 / 57.0% | 6.2 / 1.7% | 368.8 |
| 高频小 chunk（5 字符/30ms） | 150.9 / 43.6% | 0.0 / 0.0% | 0.0 / 0.0% | 0.3 / 0.1% | 189.3 / 54.6% | 5.9 / 1.7% | 346.4 |

## Part B

| 场景 | 模式 | latency p50 | latency p95 | 停流追平 | 掉帧 | 最长帧 | 最长 long task | Profiler CPU 累计 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 长代码流式 | smooth | 64.5 | 103.1 | -0.4 | 0 | 18.7 | 0.0 | 257.6 |
| 长代码流式 | direct | 61.2 | 102.8 | 10.0 | 0 | 18.7 | 0.0 | 252.2 |
| 长散文 | smooth | 70.0 | 108.6 | 4.7 | 0 | 18.7 | 0.0 | 40.0 |
| 长散文 | direct | 65.8 | 104.8 | 0.0 | 0 | 18.7 | 0.0 | 41.9 |
| 高频小 chunk（5 字符/30ms） | smooth | 59.9 | 105.9 | 5.7 | 0 | 18.7 | 0.0 | 74.4 |
| 高频小 chunk（5 字符/30ms） | direct | 59.3 | 104.2 | 15.6 | 0 | 18.7 | 0.0 | 81.3 |

## 截图

- 长代码流式 / smooth：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-smooth-frame-4.png)
- 长代码流式 / direct：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-code-direct-frame-4.png)
- 长散文 / smooth：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-smooth-frame-4.png)
- 长散文 / direct：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/long-mixed-prose-direct-frame-4.png)
- 高频小 chunk（5 字符/30ms） / smooth：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-smooth-frame-4.png)
- 高频小 chunk（5 字符/30ms） / direct：[帧 1](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-1.png) · [帧 2](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-2.png) · [帧 3](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-3.png) · [帧 4](/Users/linchen/Downloads/ai/code-agent-worktrees/pacingdoc/tests/eval/pacing/artifacts/screenshots/high-frequency-small-chunk-direct-frame-4.png)

运行环境：Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.7778.96 Safari/537.36

固定参数：accumulator=150ms；MessageBatcher 配置=50ms（文字主链未调用）；Markdown throttle=96ms。
