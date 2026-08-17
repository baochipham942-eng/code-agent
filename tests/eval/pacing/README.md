# N-L5-PACING harness

只读复刻当前 renderer 节奏链，生产代码零插桩：

- Part A：150ms accumulator → React Profiler commit → `useSmoothStreamingText` → 96ms markdown throttle（命中时）→ rAF paint opportunity。
- `stream_chunk` 当前绕过 `useMessageBatcher`，因此主链 batcher 调用数和耗时均为 0；50ms 配置仅作为架构核对项记录。
- Part B：同一 chunk 序列、同一渲染器下比较 smooth、direct 与 `@convex-dev/agent@0.6.4/useSmoothText`；comparison 模式移除 accumulator，隔离平滑层本身。

运行：

```bash
npm pack @convex-dev/agent@0.6.4 --pack-destination /tmp
mkdir -p node_modules/@convex-dev/agent
tar -xzf /tmp/convex-dev-agent-0.6.4.tgz -C node_modules/@convex-dev/agent --strip-components=1
npx tsx tests/eval/pacing/run.ts
npx tsx tests/eval/pacing/generate-report.ts
```

可见时刻定义为：对应 source prefix 已进入生产 Markdown renderer，React commit 后到达下一次 `requestAnimationFrame` paint opportunity。Markdown 控制字符本身不产生字形，所以不能用 DOM `textContent` 与源字符做一一映射。
