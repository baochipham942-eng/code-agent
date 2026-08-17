# N-L5-PACING harness

只读复刻当前 renderer 节奏链，生产代码零插桩：

- Part A：150ms accumulator → React Profiler commit → `useSmoothStreamingText` → 96ms markdown throttle（命中时）→ rAF paint opportunity。
- `stream_chunk` 当前绕过 `useMessageBatcher`，因此主链 batcher 调用数和耗时均为 0；50ms 配置仅作为架构核对项记录。
- Part B：同一 chunk 序列、同一渲染器下比较 smooth 与 direct；comparison 模式移除 accumulator，隔离平滑层本身。

运行：

```bash
npx tsx tests/eval/pacing/run.ts
npx tsx tests/eval/pacing/generate-report.ts
```

可见时刻定义为：对应 source prefix 已进入生产 Markdown renderer，React commit 后到达下一次 `requestAnimationFrame` paint opportunity。Markdown 控制字符本身不产生字形，所以不能用 DOM `textContent` 与源字符做一一映射。

## 性能对照方法

committed 的 `artifacts/` 不是合法的性能对照物：它记的是生成它那天、那台机器、那个版本的 harness 的数字。判断改动是否让节奏变差，须在同一台机器上先后跑改动前与改动后，做同机现拍 A/B。

单次采样的中位数不可信。`longestFrameMs` 曾偶发从 18.7ms 跳到 33.4ms 并丢一帧，复采后回到 18.7ms/0 帧。判性能回归至少采两次，能复现才算数。
