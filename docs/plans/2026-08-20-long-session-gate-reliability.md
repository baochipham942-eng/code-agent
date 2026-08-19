# Long-session Scroll Gate 冷缓存可靠性修复

状态：现行修复记录

## 事故

PR #1261 的 Long-session Scroll Gate 在冷缓存 runner 上耗尽 10 分钟任务上限：
Chromium 安装被取消，三条确定性滚动判据全部跳过。该次 run 为 `CANCELLED`，不能作为
合并绿灯。

## 修复

- job 上限从 10 分钟调到 20 分钟，为冷缓存下载和实际正确性门分别留出时间。
- `ubuntu-latest` 使用现成系统依赖，只安装 package-lock 对应的 Playwright Chromium，
  不再重复执行 `--with-deps` 的 apt 流程。
- workflow 合同测试固定上述两项，防止后续退回“下载吃完窗口、测试没运行”的形态。

## 验收

- `tests/scripts/longSessionBrowserSmoke.test.ts` 全绿。
- PR 上 Long-session scroll correctness 必须真实运行并成功；`CANCELLED`、跳过核心步骤或
  仅上传收尾均不算通过。
