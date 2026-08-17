# N-L5-MDSWAP harness

固定 seed `0x4e454f`，20 条 fixture × 2 种切法 × 2 条管线。相邻 tick 至少间隔 150ms；计时只覆盖 React 提交及两个 rAF settle，不把剩余 cadence 等待算进渲染 CPU 时间。

```bash
npx tsx tests/eval/mdswap/run.ts
npx tsx tests/eval/mdswap/bundle-size.ts
```

原始数据与截图生成在 `tests/eval/mdswap/artifacts/`。两侧同轮交替，终态分别与同库 static/一次性整段渲染的 normalize DOM 比较。
