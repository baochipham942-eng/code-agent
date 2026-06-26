# Verification Loop 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇归 **WP-C**，推荐优先级 **4（对非程序员信任增益最大——用户看不懂代码，只能信"完成证据"）**。要点：
> - `VerificationEvidence` 改为 `{ status, failureType, ... } & { evidenceRefs: EvidenceRef[] }`，消费统一 `EvidenceRef`（见 WP-A），不自立证据底座。
> - P0 本地闭环（VerificationPlan + related test selector v0 + Runner + 失败归因 + 三态 passed/failed/not_run）保留；**CI logs ingest + Verification Card（原 P1）押后**，等本地闭环稳定再接远端。
> - 依赖 WP-A 与 WP-B（证据链）先落地。
> 下文 P0/P1/P2 保留作 depth 参考，**实际开工以集成文档 WP-C 为准**。

日期：2026-06-26

范围：Agent Neo coding agent 从“改完”走到“可证明完成”的验证闭环。本文只覆盖验证计划、相关测试选择、验证执行、失败归因、证据写回、CI 日志接入和用户可见表达，不覆盖完整 CI 平台建设。

## 判断

Verification Loop 的长期价值是把 completion 从一句模型自述变成一条可审计的完成证明链。

业内当前成熟方向有五个共性：

1. 任务开始时就明确验收条件，例如测试通过、行为改变、bug 不再复现。
2. 改动后自动或半自动选择相关验证，而不是只跑全量或只靠用户手写命令。
3. 验证失败时把 stdout、stderr、exit code、耗时和失败类型回灌给 agent。
4. 验证结果进入可追溯载体，例如 PR、CI 日志、session trace、review record。
5. 无法验证时明确说明缺口，不能把未运行的检查包装成已完成。

Neo 当前方向正确：`attempt_completion` 只是申请退出，完成判定权已经放到代码层。真正的差距在于验证链路还停留在“用户给一条 verifyCommand，系统按退出码守门”，缺少面向 coding agent 的 `VerificationPlan` 和 `VerificationEvidence`。

因此长期方案不该再做一个零散测试按钮，而是把验证变成 agent runtime 的一等对象：计划可生成，执行可复现，失败可归因，证据可回放，结果可被用户和后续 agent 信任。

## 目标形态

目标形态是一套覆盖本地、CI、artifact 和 trajectory 的 Verification Loop：

```text
user goal / code change
  -> VerificationPlan
  -> related test selector
  -> VerificationRunner
  -> failure attribution
  -> verification_evidence ledger
  -> trajectory / replay / UI Verification Card
  -> final answer with passed / failed / not_run
```

理想用户体验：

- Agent 开始实现前知道“什么叫完成”，并能把软目标拆成可执行验证项。
- Agent 修改文件后，系统根据 changed files、repo scripts、邻近 tests、acceptance matrix 生成最小可解释验证计划。
- Agent 运行验证后，用户能看到每条命令的结果、选择理由、失败类型和证据摘要。
- 验证失败时，模型收到结构化失败上下文继续修，而不是只读一坨命令输出。
- 验证通过时，完成卡片和 final answer 可以引用具体证据。
- 验证没跑或跑不了时，系统给出可信表达，例如缺依赖、无相关测试、外部凭证缺失、CI 权限不足。

核心对象建议：

```ts
type VerificationPlan = {
  goal: string;
  source: 'user_verify_command' | 'package_script' | 'related_test_selector' | 'ci_failure' | 'artifact_verifier';
  changedFiles: string[];
  commands: VerificationCommand[];
  skippedChecks: VerificationSkippedCheck[];
};

type VerificationCommand = {
  id: string;
  command: string;
  cwd: string;
  reason: string;
  required: boolean;
  timeoutMs: number;
  expectedSignal: 'exit_zero' | 'output_contains' | 'artifact_pass' | 'ci_pass';
};

type VerificationEvidence = {
  commandId: string;
  status: 'passed' | 'failed' | 'not_run';
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  stdoutTail?: string;
  stderrTail?: string;
  failureType?: VerificationFailureType;
  rootCauseSummary?: string;
  evidenceRefs: Array<{ kind: 'file' | 'trace' | 'ci_log' | 'artifact' | 'trajectory'; ref: string }>;
};
```

## Neo 当前状态

已经具备的基础能力：

- `/goal` 有完成契约，`verifyCommand` / `reviewCondition` 至少需要一个。
- `attempt_completion` 只触发完成申请，不能直接让 goal met。
- `runVerifyGate()` 直接 `/bin/sh -c` 执行验证命令，按退出码判定。
- verify 失败会把截断输出注回上下文，要求模型继续修复。
- review gate 会派只读 reviewer 子代理读取真实文件，要求引用证据，默认 fail closed。
- goal loop 有 token、turn、wall clock、无进展兜底。
- artifact verifier 已经有“真实文件 / 浏览器 smoke / runtime contract 采证”的产品思路。
- agent trajectory 已经能做 replay 完整度质量门，具备后续承载 verification evidence 的位置。

当前缺口：

- 没有 `VerificationPlan`，验证仍主要依赖用户手写 `--verify`。
- 没有 related test selector，`git diff`、邻近测试、package scripts 和 acceptance matrix 没有被统一用于 completion gate。
- `runVerifyGate()` 输出是字符串级回灌，缺少结构化 `VerificationEvidence`。
- 失败没有稳定归因类型，agent 不能区分代码失败、环境缺失、依赖缺失、超时、flaky 或无法验证。
- `TurnTraceRecorder` 只记录 inference、loop decision、tool dispatch、compaction，没有 verification event。
- `AgentTrajectoryQualityGate` 关注 replay 完整度，没有表达“完成由哪些验证证明”。
- UI 侧有 goal status / notice，但没有 Verification Card。
- final answer 还没有强制区分 passed、failed、not_run。

## 长期路线

### P0：把验证证据做成 runtime 一等对象

目标：不用接外部 CI，也能让本地 coding task 的完成证明可计划、可执行、可回放。

任务 1：新增 `VerificationPlan` 数据结构

- 输入：goal contract、用户 prompt、changed files、package scripts、已知 acceptance matrix。
- 输出：一组 required / optional verification commands 和 skipped checks。
- 第一版只支持本地命令，不接 CI。
- `verifyCommand` 仍然最高优先级，作为用户明确指定的 required command。

任务 2：实现 related test selector v0

- 读取 `git diff --name-only` 和 dirty status。
- 对 changed file 做规则映射：
  - `src/main/agent/**` -> `tests/unit/agent/**`、`tests/unit/agent/runtime/**`
  - `src/renderer/**` -> `tests/renderer/**`
  - `src/main/evaluation/trajectory/**` -> `tests/unit/evaluation/trajectory/**`
  - `src/main/agent/runtime/deck/**` -> deck verifier tests / deck acceptance
  - `src/main/agent/runtime/dashboard/**` -> dashboard verifier / browser visual smoke
- 若找到邻近同名测试，优先生成 targeted command。
- 若无法定位相关测试，写入 `skippedChecks`，原因必须可读。

任务 3：抽 `VerificationRunner`

- 包住现有 `runVerifyGate()` 的 shell execution 能力。
- 记录 `command`、`cwd`、`exitCode`、`durationMs`、`timedOut`、stdout tail、stderr tail。
- 支持多命令顺序执行，required command 失败后可停止 optional command。
- 输出统一 `VerificationEvidence[]`。

任务 4：失败归因 v0

- 基于 command kind 和输出 pattern 做规则归因：
  - `test_failure`
  - `lint_failure`
  - `typecheck_failure`
  - `build_failure`
  - `env_missing`
  - `dependency_missing`
  - `timeout`
  - `permission_or_secret_missing`
  - `unverifiable`
- 归因只做短摘要，不替代完整 stdout / stderr。
- 归因结果注回模型，指导下一轮修复。

任务 5：写回 `verification_evidence`

- 新增 runtime event：`verification_evidence`。
- `goal_gate` 保留，用于 UI 当前状态；`verification_evidence` 用于长期审计。
- `TurnTraceRecorder` 增加事件类型。
- session event 持久化同样写入 evidence 摘要。
- agent trajectory export 增加 verification steps 或 evidenceRefs。

任务 6：无法验证表达

- final answer 和 goal completion summary 必须区分：
  - `passed`: 已运行且通过。
  - `failed`: 已运行但失败。
  - `not_run`: 未运行，必须给原因。
- 当所有 required checks 都是 `not_run` 时，不允许标成 fully verified。
- 当用户目标本身只要求代码修改，可以完成实现，但最终必须标出验证缺口。

P0 验收：

- 一个带 `--verify "npm run typecheck"` 的 goal 会生成 plan、执行 runner、写 evidence，并在 trajectory 中可见。
- 一个没有 `--verify` 但修改 `src/main/agent/runtime/*.ts` 的任务能自动选择至少一条 targeted test 或明确说明未选择原因。
- 验证失败时，下一轮模型收到 failureType 和证据摘要。
- final answer 不再把未运行检查写成已验证。

### P1：接入 CI logs 和用户可见 Verification Card

目标：把本地 completion evidence 和远端 CI evidence 合并成同一套用户可见证明。

任务 1：CI logs ingest

- 支持从 GitHub Actions run URL / job URL / PR checks 读取失败日志。
- 只解析 test / lint / typecheck / build 类失败。
- 输出同样映射到 `VerificationEvidence`。
- 第一版只读，不自动 push，不自动开 PR。

任务 2：CI failure attribution

- 从失败日志抽取：
  - failing job
  - failing step
  - command
  - top error lines
  - candidate files
  - likely failureType
- 将结果注入 repair loop。

任务 3：Verification Card

- 在 goal notice / run summary 里展示：
  - plan count
  - passed / failed / not_run count
  - required checks status
  - expand 后展示 command、reason、duration、output tail、evidence refs。
- UI 不做复杂 CI dashboard，只服务 completion trust。

任务 4：Reviewer 读取 evidence ledger

- 软闸 reviewer 优先读取 verification evidence 和 changed files。
- reviewer 不再主要依赖 transcript 自述。
- reviewer 输出必须引用 evidence id 或文件路径。

P1 验收：

- 给定一个失败 GitHub Actions 日志，Neo 能产出 failure attribution，并把它作为 repair context。
- Verification Card 能清楚展示至少一条 passed、一条 failed、一条 not_run。
- reviewer 能基于 evidence ledger 判断软条件是否满足。

### P2：让验证选择更聪明，降低成本和误判

目标：从规则 selector 升级为项目感知 selector，减少漏跑和过度跑。

任务 1：selector v1 引入代码关系

- 使用 import graph、repo map、test naming conventions。
- 对 changed files 推导 impact set。
- 记录每条测试选择的 confidence。

任务 2：历史验证记忆

- 记录某类文件改动过去常跑哪些测试。
- 记录 flaky commands。
- 记录环境依赖，例如需要 Chrome、需要 macOS、需要 paid model key。

任务 3：验证预算策略

- 小改动优先 targeted tests。
- runtime / shared contract 改动触发 typecheck + targeted tests。
- release / provider / security surface 改动触发 security scan 或 acceptance。
- 用户明确要求全量时再跑全量。

任务 4：trajectory completion rubric

- trajectory 不只判断 replay 是否完整，还能判断 completion 是否可信。
- 增加字段：
  - `verificationPlanPresent`
  - `requiredChecksPassed`
  - `notRunRequiredChecks`
  - `failureTypes`
  - `evidenceRefs`
  - `completionTrustLevel`

P2 验收：

- selector 对 agent runtime、renderer、trajectory、artifact verifier 四类改动能产出不同验证计划。
- 同一改动 repeated run 能复用历史选择理由。
- trajectory review packet 能看到 completion trust level。

### Later：多 agent 与跨环境验证

目标：让 Verification Loop 覆盖 swarm、cloud、desktop artifact 和 release readiness。

候选方向：

- 子 agent 产出自己的 verification evidence，父 agent 汇总。
- CI、本地、artifact verifier 三类证据合并去重。
- release workflow 的 readiness checks 进入同一 evidence ledger。
- 对无法自动验证的桌面/UI动作，支持人工截图、日志摘要、Replay evidence 作为 manual evidence。
- 对高风险 patch 自动触发 reviewer subagent 或 security scan。

## 关键实现区域

以下路径相对仓库根目录 `/Users/linchen/Downloads/ai/code-agent`。

完成闸和 goal runtime：

- `src/main/agent/goalVerifyGate.ts`
- `src/main/agent/goalReviewGate.ts`
- `src/main/agent/goalModeController.ts`
- `src/main/agent/runtime/goalCompletionGate.ts`
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/runtime/toolArtifactValidationLifecycle.ts`
- `src/shared/contract/agent.ts`

trace / trajectory / replay：

- `src/main/agent/runtime/turnTrace.ts`
- `src/main/evaluation/trajectory/trajectoryBuilder.ts`
- `src/main/evaluation/trajectory/trajectoryExporter.ts`
- `src/shared/contract/agentTrajectory.ts`
- `tests/unit/evaluation/trajectory/**`

测试选择和 eval：

- `src/main/testing/ci/changeDetector.ts`
- `scripts/eval-ci.ts`
- `docs/acceptance/agent-runtime-smoke-matrix.md`
- `scripts/acceptance/**`

artifact verification 可借鉴区域：

- `docs/architecture/artifact-verification.md`
- `src/main/agent/runtime/gameArtifactValidator.ts`
- `src/main/agent/runtime/deck/DeckVerifier.ts`
- `src/main/agent/runtime/dashboard/**`
- `src/main/agent/runtime/browser/visualSmoke.ts`
- `src/main/services/core/repositories/ArtifactIssueRepository.ts`

UI：

- `src/renderer/hooks/agent/effects/useConversationStreamEffects.ts`
- `src/renderer/**/GoalStatusBar*`
- `src/renderer/**/GoalNoticeMessage*`
- 后续新增 `VerificationCard` 或并入 goal notice 展示层。

## 验收标准

P0 验收标准：

- `VerificationPlan` 能从 goal contract 和 changed files 生成。
- `verifyCommand` 仍能按现有行为通过/失败，不破坏当前 `/goal`。
- 至少支持一条用户指定验证命令和一条自动选择的 targeted test。
- 验证执行结果包含 command、cwd、exitCode、duration、timedOut、output tail。
- 失败归因至少覆盖 test、lint、typecheck、build、env missing、timeout、unverifiable。
- `verification_evidence` 写入 turn trace 和 session event。
- trajectory export 能带出 verification evidence 摘要。
- final answer 明确列出 passed / failed / not_run。

P1 验收标准：

- 能从一个 GitHub Actions failure log 生成 `VerificationEvidence`。
- 能把 CI failure root cause 注入 repair loop。
- Verification Card 在 UI 中展示 required checks 的状态。
- reviewer 可以引用 evidence ledger 作出 PASS / FAIL。

P2 验收标准：

- related test selector 能解释每条测试为什么被选择。
- selector 对常见改动区域有稳定映射。
- history / flaky / env metadata 不会导致默认误跑高成本检查。
- trajectory review 可以按 completion trust level 排序。

总体完成标准：

- 用户、reviewer、后续 agent 都能回答三个问题：
  - 这次完成靠什么证据证明？
  - 还有哪些检查没跑，为什么？
  - 如果失败，最可能的失败归因是什么？

## 风险与未决问题

风险 1：相关测试选择误判

- 漏跑会降低信任，过度跑会拖慢 agent。
- P0 应保持规则透明，每条选择都写 reason。

风险 2：环境问题和代码问题混在一起

- 例如 `node_modules` 缺失、Chrome 缺失、provider key 缺失。
- 失败归因必须把 env missing 和真实 test failure 分开。

风险 3：输出太长污染上下文

- stdout / stderr 只能存 tail 和摘要。
- 完整日志通过 evidence ref 指向文件或 CI log。

风险 4：CI 凭证和权限边界

- P1 初期只读 CI logs。
- 不默认 push，不默认开 PR，不把 GitHub token 暴露给模型命令。

风险 5：UI 过载

- Verification Card 默认展示结论和 counts。
- 命令输出、日志和 refs 放到展开区。

风险 6：软闸 reviewer 过度相信 evidence

- Evidence ledger 证明“跑过什么”，不天然证明“产品目标满足”。
- 软闸仍要检查目标与证据是否匹配。

未决问题：

- `VerificationPlan` 应该放在 goal runtime 内，还是作为通用 runtime service。
- trajectory schema 是否直接扩 `AgentTrajectoryStep`，还是新增单独 evidence block。
- CI logs 首期只支持 GitHub Actions，还是抽 provider interface。
- Artifact verifier 的 evidence contract 是否与 coding verification 共用一套类型。
- 用户手动验证证据如何进入 ledger，例如截图、手工命令、外部系统确认。

## 证据来源

外部官方资料：

- Aider lint/test docs：`https://aider.chat/docs/usage/lint-test.html`
- GitHub Copilot coding agent docs：`https://docs.github.com/en/copilot/concepts/coding-agent/coding-agent`
- Claude Code hooks docs：`https://docs.anthropic.com/en/docs/claude-code/hooks`
- Devin CI fix docs：`https://docs.devin.ai/use-cases/gallery/api-github-actions-ci-fix`
- OpenAI Codex manual：`https://developers.openai.com/codex/codex-manual.md`

本仓证据：

- `package.json`
- `src/main/agent/goalVerifyGate.ts`
- `src/main/agent/goalReviewGate.ts`
- `src/main/agent/goalModeController.ts`
- `src/main/agent/runtime/goalCompletionGate.ts`
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/runtime/turnTrace.ts`
- `src/main/agent/runtime/toolArtifactValidationLifecycle.ts`
- `src/shared/contract/agent.ts`
- `src/shared/contract/agentTrajectory.ts`
- `src/main/testing/ci/changeDetector.ts`
- `scripts/eval-ci.ts`
- `docs/architecture/artifact-verification.md`
- `docs/acceptance/agent-runtime-smoke-matrix.md`
