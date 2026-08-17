# N-L5-MDSWAP harness

固定 seed `0x4e454f`，20 条 fixture × 2 种切法 × 2 条管线。相邻 tick 至少间隔 150ms；计时只覆盖 React 提交及两个 rAF settle，不把剩余 cadence 等待算进渲染 CPU 时间。

```bash
npx tsx tests/eval/mdswap/run.ts
npx tsx tests/eval/mdswap/bundle-size.ts
```

原始数据与截图生成在 `tests/eval/mdswap/artifacts/`。两侧同轮交替，终态分别与同库 static/一次性整段渲染的 normalize DOM 比较。

## 性能对照方法

committed 的 `artifacts/` 只记录生成它那天、那台机器、那个版本的 harness，不能作为性能对照。判断改动是否让节奏变差，须在同一台机器上先后跑改动前与改动后，做同机现拍 A/B。

单次采样的中位数不可信。`longestFrameMs` 曾偶发从 18.7ms 跳到 33.4ms 并丢一帧，复采后回到 18.7ms/0 帧。判性能回归至少采两次，能复现才算数。
