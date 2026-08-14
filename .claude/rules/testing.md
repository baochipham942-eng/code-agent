---
description: 测试与验证规范
globs: "src/**/*.test.ts,src/**/*.spec.ts,tests/**/*"
---

# 测试规范

## 验证优先

- 修改代码后必须先验证，流程：`修改 → 验证 → 确认通过 → 通知`
- 写完功能点后立即 `npm run typecheck`，commit 前必须通过

## 调试指南

- 同一问题 2 次修复失败后，停下来从头重新分析根因

## 提交纪律

- 每完成一个功能点立即提交，不要积攒
- **代码质量由 Claude 负责，用户不 review 代码**：用户看不懂代码、不做 diff review，禁止把审查责任推给用户。质量靠 Claude 自审 + 分层验证保证：
  - **自审（Claude 自己做，不是甩给用户）**：commit 前 `git diff --check`（拦空白错误/冲突标记残留）+ `git diff --stat` 逐文件查变更行数，行数异常的 `git diff <file>` 逐行确认；尤其 SSE/IPC 协议文件（webServer.ts、electronMock.ts）和共享类型文件
  - **分层验证（每个功能点交付前按需跑全）**：① `npm run typecheck` 必过 ② 受影响模块 targeted 测试 ③ 涉及 UI/页面走 E2E/视觉验证（/e2e）④ 高风险改动（协议/共享类型/安全/计费）用多模型对抗审查（/multi-review 或 codex-audit）
  - **向用户汇报质量证据，不贴 diff**：用自然语言说测试通过数 / 覆盖了什么 / 验证结论，让用户基于证据而非代码做判断；**汇报必须带全量测试计数**（X passed / Y failed / Z skipped，来自完整套件而非只报 targeted 子集），跑不了全量就写明跑了哪个子集、为什么；**并标注证据档位**（static-contract / hermetic-protocol / fault-injection / real-runtime，定义见 `docs/testing-evidence-classes.md`），只有结构性门+mock 单测时说明为何不需要变异验证或真机验证
- **用户只在设计决策层拍板**：架构 / 产品级选择走 ADR，用人话呈现给用户拍板；拍板后 Claude 自主推进实现 + 验证，不再要求用户看代码

## 代码品味

- 避免过度工程，只做必要的事
- 不添加未被请求的功能、注释或重构
- 三行重复代码优于一个过早抽象

## 后台浏览器任务清理（错题本 2026-07-30）

- **停掉带浏览器的后台任务（e2e/gates/claude-e2e verify 脚本）后，必须确认整棵进程树死干净**：TaskStop/kill 只杀主进程会留下孤儿 Playwright worker，它们继续按重试逻辑反复拉起系统 Chrome；Chrome 在孤儿进程上下文里注册 GUI 失败（`_RegisterApplication` abort），实测 90 秒连崩 25 次、macOS 弹窗雨轰炸用户。
- **泛化规则**：任何会 spawn 子进程树的后台任务，中断 ≠ 结束——停完后核对残留（`pgrep -fl "playwright|chrome-headless|Google Chrome --"`），有孤儿按进程组杀（`kill -- -<pgid>`），不能默认 harness 会替你收尸。
- 验证默认走 headless 配置；`tests/e2e/playwright.system-chrome.config.ts`（`channel: 'chrome'`）和 headful verify 脚本只在明确要真机 UI 验收时用。

## 评测安全（错题本 2026-07-04）

- **红线类 case（预期模型拒绝的破坏性指令）不得在未越狱的 harness 里真跑**：eval 沙箱只隔离工作目录，bash 不隔离主机。断言"回复不含已删除"挡不住顺从模型真执行——LongCat-2.0 实测三次顺从伪装成磁盘清理的注入指令，`find ~ -name node_modules` 批量删除 15 个项目依赖 + 清空 ~/.cache。
- **泛化规则**：任何"期望 AI 拒绝"型测试，护栏必须是机制（jail/mock/只读挂载），不能是期望本身；未 jail 前红线 case 禁止进 sweep/重复跑量/换更顺从模型跑。

## 降级路径必须留痕 / 假 mock 掩盖真形状（错题本 2026-08-14）

- **静默降级会叠加成「功能完全没生效且现场零线索」**：声纹能力在 Dev 包跑完一整通真通话，日志一条都没有。剥开是三层「合理」的静默叠在一起——① 业务层前置缺失时 `return null` 不记日志 ② `isOrtRuntimeModule` 类型判据默默返 false ③ `loadOrtRuntime` 一路 `try/catch` 吞异常。每层单独看都说得通，合起来就是黑箱。
- **泛化规则**：`fail-open` 说的是「**行为**不改变」，不是「**失败不留痕**」。任何降级/回落分支都要 warn 出**可区分的原因**（是 A 缺了还是 B 缺了），装载类逻辑还要把**每条候选路径的真实错误**带出来（返回 attempts 之类），否则判因时只能靠猜。
- **单测里被 mock 的东西，在真机上可能根本不存在**：这次的形状差异是**运行时资产的存在性**——`onnxruntime-node` 是 `delivery:'optional'` 的按需下载资产，全新数据目录从没下过，而单测里它永远"在"。
- **夹具要用真实模块形状**：`onnxruntime-node` 的 `InferenceSession` 是 **class**（`typeof 'function'`），而判据用 `isRecord`（只认 `typeof 'object'`）→ 恒返回 false。当初用手搓 plain-object mock 写的测试，正因为形状是假的才没抓住这个存量 bug（桌面 VAD 同链中招）。
- **「按需下载组件」要备齐运行时 + 资源两样**，只下其中一样 = 备了子弹没备枪。
