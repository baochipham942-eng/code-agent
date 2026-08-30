# Ship Note — feat/cli-startup-error-path（启动性能 + 鉴权错误路径）

> 日期：2026-08-30 · 分支：feat/cli-startup-error-path（1 commit）
> 用户实测反馈：进首页到输入框可输入 ~8s；longcat 欠费发 prompt 卡死 ~25s
> 无反馈，最后报看不懂的 "Native Durable Run … is not active"。

## 范围

**启动性能**（pty 实测大目录 banner/prompt/raw-mode：7.9/8.1/8.2s → 1.3/1.4/1.5s）：

1. **folderTrustService 危险项扫描记忆化**（主修复）：技能发现曾对每个 skill
   做一次深度 5 全目录递归 trust 评估（~266 × ~18ms ≈ 5s 纯同步 IO，
   fire-and-forget 名义异步、实际饿死主线程，banner 后静默、输入卡死的真凶）。
   现按 canonical realpath 进程级缓存扫描产物；**只缓存目录扫描，不缓存
   评估结论**——trust 决策（folder_trust 表）与 identity 每次现读，决策变更
   即时生效（loader gates 语义不变，folderTrustLoaderGates 测试守住了这条）。
2. **MCP init 不挡首屏**：云端 MCP server HTTP 握手（本机 13 个串行 ~7s，
   ~/.code-agent/capabilities + cwd .env 的 CODE_AGENT_ENABLE_CUA 命中时触发）
   改为与 banner/Ink 并行；首个 agent run 经 `whenCLIMcpReady()` 等就绪
   （工具表完整性不变），之后为零成本已解决 promise。
3. 小头：`enableCompileCache()`（V8 编译缓存，热启动 −0.3~0.5s）；
   bootstrap 5 个串行动态 import 改 `Promise.all`；inkRunner/yoga 加载与
   init services 并行。

**鉴权错误路径**（longcat 欠费卡死 ~25s + 报内部 runId 错误的修复）：

4. **checkpoint 错误不顶替模型错误**：`nativeModelCheckpoint` 的
   prepared/dispatched/succeeded 三处 checkpoint 补 catch——run 半注销时
   "Native Durable Run … is not active" 只降级为不做 durable 记账，
   模型真实结果/错误原样透出。
5. **鉴权类不可重试**：`retryStrategy.isRetryableModelCallError` 加显式 4xx
   护栏（400-404/409/422 绝不重试），`NON_RETRYABLE_PATTERNS` 收录中文
   欠费/鉴权文案——欠费不再被误重试白等 ~15s 退避（429 限流除外）。
6. **错误人话化**：`modelErrorDiagnostics` 新增 `auth_failed` /
   `quota_exhausted` 分类；`runFinalizer.formatTerminalError` 过分类器，
   用户看到「模型鉴权失败/余额不足 + 建议（/login 配置、/model 切换）」。

## 验证证据

- **全量**：`npx vitest run`（结果以 PR CI 为准；本地相关套件：
  security 291、model 90、cli 206、shared、nativeModelCheckpoint 全绿）
- **质量门**：typecheck 0 错；build:cli 成功；eslint 改动文件 0 告警；knip 三门全过
- **pty 启动计时**（/tmp/neo-p0-sandbox/startup_timer.py，等 raw mode + drain）：
  `~/Downloads/ai`（大目录 + 13 云端 MCP）banner/prompt/raw
  7.88/8.06/8.16s → 1.26/1.40/1.50s；`code-agent` 1.18/1.32/1.42s
- **新单测**：folderTrust 缓存语义（决策新鲜/扫描缓存）、retryStrategy
  4xx/statusCode/中文文案、modelErrorDiagnostics auth/quota、
  nativeModelCheckpoint 降级四例；adapter mock 同步
- **非 TTY 回归**：`(sleep 5; printf '/exit\n') | node dist/cli/index.cjs` exit 0

## 偏差与遗留

- 目录扫描缓存进程级：会话中后落盘的危险配置不再即时发现（决策仍即时），
  与 defaultProjectConfigTrust 短路同属"跳过一次评估"的合法语义
- run 半注销的生命周期根因（recoverDurable 无 handle 重水合 /
  terminalCLIDurableRun 失败只 warn）未动，checkpoint 降级后不再伤人，
  留作后续卫生项
- MCP init 延后后，启动即秒发首条 prompt 的 run 会等 MCP 握手（spinner 可见）；
  后续可考虑工具表增量注册
- 欠费冒烟未用真模型复测（longcat 账户状态不可控）；分类/重试/降级均有单测
