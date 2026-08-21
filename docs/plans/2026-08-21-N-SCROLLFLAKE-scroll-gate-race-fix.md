# N-SCROLLFLAKE：Long-session scroll gate 竞态修复

日期：2026-08-21<br>
基点：`b7d88430cc5f1c539491861697c4b2f7355c2f09`

## 根因

`scripts/perf/long-session-browser-harness.tsx` 的两个子门都在 Virtuoso 异步滚动和虚拟列表测量尚未收敛时采样：

- `streamingFollow` 点击“回到底部”后固定等待 500ms，再读取 `distanceFromBottom`。GitHub 慢 runner 上，动态高度测量可能在采样后继续改变 scrollHeight，已出现 `distanceFromBottomPx=141`。
- `search` 原逻辑只等待 `turn-121` 第一次挂载，挂载后立即计算可见性；更坏的分支是 Virtuoso 丢掉一次长距离 `scrollToIndex` 后，目标始终未挂载。`TurnBasedTraceView` 的搜索 effect 只在 `activeMatchIndex` 变化时发一次导航，没有新的状态变化就不会自愈，已出现 `targetMounted=false`。

旧尝试 `0be90ab95` 只把 workflow timeout 从 10 分钟增到 20 分钟，并调整 Playwright Chromium 安装方式。它降低冷缓存安装超时风险，没有触及上述采样和导航时序，所以不能修复已经进入浏览器剧本后的红白交替。

## 修法与取舍

新增 `scripts/perf/wait-for-stable.ts`，要求条件连续 200ms 成立才返回；每 50ms 采样，超时返回 `null` 并让门失败。

- `streamingFollow`：等待原阈值 `distanceFromBottom <= 96` 与“回到底部”按钮消失同时稳定成立，再采样。最终判定仍保留 `distanceFromBottom <= 96`。
- `search`：等待 `turn-121` 已挂载且与 scroller 可视区相交同时稳定成立。一次导航 1 秒内未收敛时，在子门内部重新发出同一个 active match 导航，最多 5 次；到上限仍失败。

选择确定性稳定等待，是因为门需要观察真实 UI 条件，而固定 sleep 只能猜 runner 速度。Search 在实跑中证明一次导航可能被 Virtuoso 丢弃，因此在确定性等待外增加有界的子门内重试。没有采用整体 rerun，避免把真实回归也随机洗绿；没有扩大 96px 阈值，也没有放松目标挂载或可见性判定。

## 连跑对照

统一命令：

```bash
E2E_BROWSER_CHANNEL=chromium npm run perf:long-session -- \
  --out <temp-report.json> --gate-profile correctness
```

环境：Playwright Chromium `148.0.7778.96`；单跑冷启动约 17.7 秒，连续热跑约 6–8 秒。

| 版本 | 结果 | 说明 |
|---|---:|---|
| 原等待逻辑 | 0/10 红，flaky 率 0% | 本机负载未自然复现 GitHub runner 的四次既有红灯 |
| 仅稳定等待的中间版本 | 1/10 红，flaky 率 10% | 第 7 跑复现 `search targetMounted=false`，证明等待本身不能恢复被丢弃的导航 |
| 稳定等待 + search 子门内有界重试 | 0/10 红，flaky 率 0% | 10 次全部三个 correctness gates 通过；streaming distance 均为 0，search 均 mounted + visible |

原逻辑与最终版的本机随机统计都是 0/10，不能宣称本地 flaky 率数值下降；有效增量证据是中间版本真实复现 1/10 后，补上精确导航重试并回到 0/10。原始报告分别保存在本机 `/tmp/n-scrollflake-chromium-baseline.7gK1hq`、`/tmp/n-scrollflake-chromium-fixed.A8syJC` 和 `/tmp/n-scrollflake-chromium-final.Y7Inip`。

## 反向变异

临时把 `waitForStable` 恢复成旧的“首次条件命中即返回”语义，运行：

```bash
npx vitest run tests/scripts/longSessionBrowserSmoke.test.ts
```

结果：退出码 1，7 项中 2 项失败。

- 瞬时成立后回退的条件在第 2 次采样被错误接受：`expected 2 to be greater than or equal to 6`。
- 持续真假抖动的条件被错误接受：`expected true to be null`。

恢复稳定等待后同文件 7/7 通过。

## 本地门禁

- `npm run typecheck`：通过。
- `npx tsc --noEmit -p tsconfig.tests.json`：通过。
- `npx eslint scripts/perf/long-session-browser-harness.tsx scripts/perf/wait-for-stable.ts tests/scripts/longSessionBrowserSmoke.test.ts`：通过。
- `npx vitest run tests/scripts/longSessionBrowserSmoke.test.ts`：7/7 通过。
- Chromium correctness gate 最终版连续 10 次：10/10 通过。
