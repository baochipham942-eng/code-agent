# Neo 稳定性、可信度与长会话改进计划

> 日期：2026-07-11
> 类型：Implementation / Stability Release
> 参考对象：CodePilot v0.56.2～v0.58.0
> Neo 基线：`origin/main`，制定计划时为 `14688f718`

## 1. 产品判断

Neo 已具备较完整的运行隔离、上下文压缩、安全存储、工具安全和评测基础。当前主要欠账集中在两类证据：

1. 长会话、停止、断线、崩溃恢复等能力已经分别实现，缺少覆盖完整用户路径的统一稳定性验收。
2. 多 Provider 与多 Runtime 覆盖范围很大，缺少持续维护的能力矩阵、请求形状 fixture 和真实渠道 Smoke Ledger。

本计划不扩展新的工作面，不增加 Provider，不引入新的 Agent 模式。目标是把现有能力收敛成一个用户能明确感知的 Stability Release。

## 2. 从 CodePilot 借鉴什么

### 2.1 借鉴产品节奏

CodePilot 最近版本把以下问题组成了一轮完整的稳定性战役：

- 停止与中断的所有权和生命周期；
- 长会话虚拟化、滚动锚点、代码高亮主线程开销；
- 会话恢复、慢渠道超时、错误诚实传播；
- Provider 参数能力矩阵；
- 已知问题、实验路径和有意暂缓项的公开表达。

Neo 值得复制的是这种集中收口方式。单项实现不需要照搬。

### 2.2 Neo 已经领先的能力

- `RunContext` / `RunRegistry` 已进入主线，同 Session 并发启动会被拒绝，取消、断线和工具状态按 Run 隔离。
- 对话 UI 已使用 `react-virtuoso`，具备历史分页、流式跟随和主动滚动抑制。
- 上下文系统已有多层 prune、压缩经济性闸、Survivor Manifest、checkpoint rebuild 和压缩审计。
- API Key 已进入加密存储，安全存储不可用时仍走 AES 密文降级。
- workspace realpath、symlink escape、sandbox、日志脱敏、工具账本脱敏已经形成多层边界。
- 评测体系已有外部锚点、trajectory 回流、Goal 三闸、compare arm 和 CI 棘轮。

### 2.3 Neo 仍需补齐的缺口

- `stream-snapshot.json` 仍按 working directory 固定命名。同一项目内并发 Session 可能互相覆盖快照。
- 长会话实现有组件级测试，缺少 500～1000 回合、密集代码块、历史加载和持续流式输出的性能与行为金标。
- Provider 能力分散在 provider adapter、model capability 和各 Runtime 中，缺少统一的可核验矩阵。
- Stability Release 缺少用户可见的已知问题、实验能力和暂缓项清单。

## 3. 目标与非目标

### 3.1 目标

- 同一 workspace 下不同 Session、不同 Run 的流式快照完全隔离。
- 停止、取消、断线、进程崩溃后的状态能够确定性收敛。
- 长会话在目标设备上有可重复的性能基线和回归门。
- 多 Provider 能力声明由 fixture、自动测试和真机 smoke 共同支撑。
- 发版材料能明确说明行为变化、实验能力、已知问题与暂缓项。

### 3.2 非目标

- 不升级 AI SDK 默认运行时。
- 不新增模型、Provider、Bridge 渠道、Agent Surface 或媒体能力。
- 不重构整个 Agent Engine。
- 不改动已经稳定的外部协议，除非测试证明现有协议无法表达 run identity。
- 不为了统一代码风格触碰任务范围外文件。

## 4. P0：Stability Release 主链路

### 4.1 P0-A：流式快照按 Session / Run 隔离

#### 当前问题

`src/host/session/streamSnapshot.ts` 以 working directory 下单个固定文件保存快照。并发会话共享项目目录时，晚写入者会覆盖先写入者；旧 Run 的清理也可能删除新 Run 的快照。

#### 推荐契约

快照身份至少包含：

```text
workspace + sessionId + runId + turnId
```
推荐存储结构：

```text
<workspace>/.code-agent/stream-snapshots/<sessionId>/<runId>.json
```

每份快照包含：

- `schemaVersion`
- `sessionId`
- `runId`
- `turnId`
- `updatedAt`
- `streamStatus`
- `stableForExecution`
- `incompleteToolCallIds`
- 流式正文与已完成工具调用

#### 必须先写的失败测试

- 同一 workspace 两个 Session 同时写入，分别读回各自内容。
- 同一 Session 的旧 Run 清理时，不删除新 Run 快照。
- 同一毫秒启动的两个 Run 不发生文件名冲突。
- 残缺 tool call 在恢复后只展示证据，不进入执行队列。
- 旧版单文件快照可以安全迁移或被明确忽略，不静默挂到错误 Session。
- 临时文件写入中进程终止，正式快照保持可解析。

#### 验收证据

- 定向单测通过。
- 两个真实并发 Session 在同一项目运行并强退，重启后各自恢复正确内容。
- 快照目录中没有明文凭据、越界路径或无法归属的孤儿文件。

### 4.2 P0-B：长会话金标与性能基线

#### 覆盖场景

建立确定性 fixture，至少覆盖：

1. 500 回合普通文本会话。
2. 1000 回合混合文本、thinking、tool call 会话。
3. 100 个代码块持续流式更新。
4. 顶部加载 30 条历史消息后保持视口锚点。
5. 用户上滚期间继续收到流式增量，页面不抢回底部。
6. 回到底部后恢复自动跟随。
7. 搜索命中未挂载的虚拟列表项并正确定位。
8. 权限卡、错误卡和进行中 Turn 出现在长会话尾部时保持可操作。

#### 建议指标

先在目标 Mac 上记录基线，再把阈值写入测试。首版建议：

- 500 回合会话可交互时间不超过 2 秒。
- 加载 30 条历史后的可见锚点漂移不超过 16px。
- 点击停止后 1 秒内进入稳定终态。
- 停止确认后不再出现新的 tool execution begin。
- 100 个代码块持续更新期间，不出现持续 500ms 以上的主线程阻塞。
- 1000 回合场景内存峰值与空会话基线相比有明确上界，并记录机器规格。

性能阈值不能只在注释里存在，至少输出结构化 JSON 报告供 CI 或人工 Gate 比较。

#### 需要的测试层级

- 纯函数：滚动跟随、锚点选择、终态判定。
- 组件测试：Virtuoso wiring、加载历史、搜索定位、流式状态。
- 浏览器 E2E：真实滚动容器和高度变化。
- Dogfood smoke：真实 App、真实长会话、性能报告。

### 4.3 P0-C：停止、断线与恢复的统一金标

已有 RunRegistry 测试保留，并补齐跨层场景：

- 同 Session 第二个 Run 在 SSE 200 前返回 409。
- 多 Session 并发时，无 selector 的 cancel fail-closed。
- 按 runId 取消只影响目标 Run。
- SSE 断线只取消绑定的 Run，并释放对应槽位。
- cancel 发生在 loop attach 之前时，Session 保持占用直到旧 Run 收敛。
- 旧 Run 的 terminal、cleanup、snapshot clear 不能影响新 Run。
- 用户消息在取消或崩溃前已经落库，assistant/tool 残缺状态可解释。
- Stop 后消息队列、权限等待、MCP 调用、子 Agent 和后台 Worker 都能按同一 ownership 收敛。

#### 完成定义

P0 完成需要同时满足：

- 快照隔离实现与迁移测试通过。
- 长会话结构化基线报告生成。
- 停止/断线/恢复跨层测试通过。
- `npm run typecheck` 通过。
- 定向 Vitest、相关 renderer 测试和 E2E 通过。
- `git diff --check` 通过。
- 回读全部改动文件，没有无关重构和用户 WIP 混入。

## 5. P1：Provider × Runtime 能力矩阵

### 5.1 矩阵维度

Runtime：

- Native
- Codex CLI
- Claude Code
- MiMo Code
- Kimi Code

协议族：

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses
- OpenAI-compatible gateway
- 本地 Ollama / LiteLLM 类端点

能力：

- 普通文本流式输出
- reasoning / effort
- `tool_choice`: auto / none / required / named
- 图片输入
- PDF / 文件输入
- 流式工具调用参数完整性
- usage / context window 来源可信度
- stop / abort
- connect timeout / first-token timeout / stream idle timeout
- 上游错误分类与用户可见信息

### 5.2 三层证据

每个被标记为 supported 的格子需要：

1. request-shape fixture：锁定最终上游请求结构。
2. 自动测试：覆盖参数门控、错误和降级。
3. live smoke ledger：记录日期、Provider、模型、协议、结果和脱敏证据。

未满足三层证据的能力只能标记为 experimental、unknown 或 unsupported。

### 5.3 AI SDK 7 决策门

AI SDK 7 只开独立 Spike，不直接升级生产默认路径。采用条件：

- 至少减少一组可量化的自定义 adapter 代码或已知 Bug 类别。
- Provider 矩阵中的已有绿色格不退化。
- tool call、usage、abort、timeout 和错误传播达到当前生产语义。
- POC 代码与生产路径物理隔离，默认关闭。

若收益只来自类型升级或未来可能性，保持 AI SDK 6。

## 6. P2：发布治理与用户信任

每个 Stability Release 固定输出：

- 本版解决的用户问题。
- 默认行为是否变化。
- 性能基线和测试覆盖。
- 实验能力与开关状态。
- 已知问题。
- 有意暂缓项。
- 回滚方式。

Issue bot、stale bot、PR label 等社区治理仅在维护成本出现后引入。Neo 当前优先建设 release blocker：阻止缺少长会话、取消恢复、Provider smoke 证据的版本发布。

## 7. 决策点

### D1：快照存储位置

推荐继续放在 workspace 的 `.code-agent` 下，身份增加 Session / Run。若 workspace 只读或不可写，回退用户数据目录，并在索引中记录 workspace fingerprint。

### D2：长会话测试进入哪一级 CI

- PR：跑确定性组件测试和轻量 500 回合场景。
- Nightly：跑 1000 回合、密集代码块和浏览器性能场景。
- Release：跑真实 App dogfood smoke，保存 JSON 报告和机器规格。

### D3：是否升级 AI SDK 7

P1 矩阵完成前不做决定。Spike 只回答“能消灭哪些真实适配问题、代价是什么”。

## 8. 风险与暂停条件

### 风险

- 当前仓库存在多个活跃 worktree 和并行线程，容易与 RunContext、评测、控制面改动冲突。
- 长会话性能测试容易受机器负载影响，必须区分确定性行为门和统计性能门。
- 快照迁移处理不当会让旧数据挂到错误会话。
- Provider 真机 Smoke 涉及付费、凭据和外部限流，不能在自动测试里默认执行。

### 暂停条件

- 目标文件与其他活跃任务重叠且无法安全拆分。
- 连续两次遇到同一失败，仍没有新的事件顺序、store key 或调用链证据。
- 需要修改对外 SessionEvent / SSE 协议，且兼容方案未确认。
- 真机 Smoke 将产生未获授权的付费调用。
- 为完成 P0 被迫扩大到 Agent Engine 全面重构。

## 9. 推荐执行顺序

1. 基于最新 `origin/main` 建独立 worktree，检查活跃任务和重叠文件。
2. 只读审计现有 RunRegistry、streamSnapshot、SessionRepository、Virtuoso 和测试。
3. 先写快照并发覆盖和旧 owner 清理新 owner 的失败测试。
4. 实现最小快照身份升级，完成迁移与定向验证。
5. 建长会话 fixture、行为金标和结构化性能报告。
6. 补停止/断线/恢复跨层测试，避免重复已有单测。
7. P0 Gate 通过后，再进入 Provider 矩阵。
8. P1 证据完整后，再开 AI SDK 7 Spike。
9. 最后补 Stability Release 模板与 release blocker。

## 10. 新会话执行提示词

```text
在 Agent Neo 仓库执行 Stability / Trust 改进计划：

计划文档：docs/plans/2026-07-11-neo-stability-trust-improvement-plan.md

先读取仓库 AGENTS.md 和计划全文。开工前完成以下检查：
1. git fetch origin，以最新 origin/main 为基线，不继承当前主工作树的脏改动；
2. 检查现有 worktree、活跃分支和正在执行的任务，确认是否与 RunContext、streamSnapshot、session、长会话 UI、eval 文件重叠；
3. 若存在冲突，先列出重叠文件和安全切片，不要同时修改；
4. 不 push，不改用户现有 WIP，不做范围外重构。

本会话主目标是完成计划 P0，P1/P2 先保留接口和证据结构，不在 P0 未通过前扩展：
- P0-A：把流式快照从 workspace 单文件升级为 sessionId/runId 隔离，旧 owner 不能清理新 owner，残缺 tool call 永不恢复执行；
- P0-B：建立 500/1000 回合、密集代码块、历史加载锚点、用户上滚、流式跟随和搜索定位的长会话金标，输出结构化性能报告；
- P0-C：补齐停止、断线、并发 Run、attach 前取消、崩溃恢复的跨层回归，复用现有 RunRegistry 测试，不重复造测试。

执行纪律：
- test-first，一次只处理一个可证明问题；
- 同一失败连续两次后，先检查真实事件排序、store key、run ownership 和既有测试约定；
- 快照身份必须至少包含 workspace/sessionId/runId/turnId；
- 保持现有 SessionEvent、SSE、UI 语义兼容；
- 真机 Provider 或付费调用必须停下等待授权；
- 每次修改后跑最小相关测试，完成一个切片后再扩大测试范围。

P0 完成证据：
- 并发 Session/Run 快照隔离与迁移测试通过；
- 旧 Run terminal/cleanup 不影响新 Run；
- 长会话 JSON 基线报告生成，锚点漂移、停止收敛、主线程阻塞和内存都有明确结果；
- 相关 Vitest、renderer 测试、E2E、npm run typecheck、git diff --check 通过；
- 回读全部改动文件，列出行为变化、测试证据、未处理边界和 P1 的准确入口。

如果 P0 全部通过且工作区、时间和上下文仍安全，再为 P1 输出 Provider × Runtime 能力矩阵的实现切片；不要直接升级 AI SDK 7。
```
