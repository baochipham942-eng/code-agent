# lody.ai 借鉴清单（给 neo）

> 来源：lody.ai（Loro CRDT 团队 / LoroHub LLC 的 ACP 编排壳）
> 调研方式：2 批 11 路并行子 agent（6 能力维度 + 1 侦察 + 4 深挖），交叉验证
> 生成日期：2026-06-16
> 说明：本文件由会话日志恢复落盘（原会话生成后未写盘）

两批 11 个 agent 全部回来，交叉验证后给你最终结论。

---

# lody.ai 借鉴分析 → neo 行动清单

## 一、先把 lody 看穿（关键前提）

**lody = Loro CRDT 团队（loro.dev / LoroHub LLC）做的 ACP 编排壳，不是一个自研 agent。** 技术底座实锤（npm `lody@0.62.0` 反编译）：`loro-crdt`(多端实时同步) + `@agentclientprotocol/sdk` + `acp-extension-claude/codex`(把 Claude Code/Codex 当可插拔 runtime) + `node-pty` + `better-sqlite3` + Convex 后端。

它自己**不写编码工具、不做真沙箱、不碰 skill 格式、不做 MCP**——这些全甩给被它托管的 CLI。它做的是上面那层**协作神经系统**：worktree 并行 + CRDT 跨端同步 + 移动异步 review + GitHub 闭环。

> ⚠️ 别被官网唬住：首页"Share Skills"实际是 planned 未交付；"sandboxed runtime"在 mac 上是 Noop（只有 Linux cgroup 资源封顶，无 FS/网络隔离）。它的护城河是 **CRDT + ACP**，不是这些。

## 二、全维度对照：哪些不用看，哪些要借

| 维度 | 判断 |
|------|------|
| 多 agent 调度 | ✅ **neo 完胜**（DAG+L0-L2 通信+级联取消 vs lody 仅 worktree 隔离靠人盯） |
| 工具系统 / 沙箱 | ✅ **neo 完胜**（真 bubblewrap/seatbelt 隔离 vs lody mac 上 Noop） |
| 权限系统 | ✅ **neo 完胜**（6 档矩阵+分类器+决策追踪 vs lody 二元 Full Access 开关） |
| MCP | ✅ **neo 完胜**（教科书级：4 transport+marketplace+server/client 双向 vs lody 根本不做） |
| 浏览器 / computer-use | ✅ **neo 完胜**（Browser+Computer 双引擎内置 vs lody 完全没有） |
| context 健康观测 | ✅ **neo 更强**（按 Skills/MCP/Subagents 拆分+可卸载 vs lody 一个百分比） |
| **多端实时协作 (CRDT)** | 🔴 **lody 领先，战略级缺口** |
| **ACP 异构 agent 接入** | 🔴 **lody 领先** |
| **移动端异步 review** | 🔴 **lody 领先，neo 最大短板** |
| **前端 diff/UX 呈现** | 🟡 **lody 有可抄的具体设计** |
| **成本/配额可观测** | 🟡 **lody 第②③层领先** |
| **session 磁盘生命周期** | 🟡 **lody 的"归档即释放磁盘"值得抄** |
| **历史接管/迁移获客** | 🟡 **lody 思路好，neo 已有 80% 地基** |

**结论先行：neo 的"大脑"全面赢 lody，要借的全在"神经系统 + 产品治理"这一层。**

## 三、值得借的清单（按价值×可行性排序）

### A 档 · 战略级（重新定位 neo，之前已聊过①②，这里补 CRDT/ACP）
1. **headless daemon + 移动/远程异步 review** —— neo 已有 `webServer.ts`+SSE+`serve` 命令地基，缺响应式 Web review + 推送通知层。
2. **CRDT 化会话状态层（Loro）** —— 把会话/diff/分支状态做成可多端同步、可接管、自带 undo 的协作文档。这是支撑"换机续接/队友围观/移动查看"的底座，neo 现在纯单机。Loro 开源(Rust+wasm)、经 lody 验证。
3. **ACP 适配层** —— 让 neo 编排器能调度 Claude Code/Codex 当子 worker，或被别的壳托管。neo 已有 `protocolRegistry` 骨架，ACP 是正在成形的事实标准。

### B 档 · 高 ROI 低成本（neo 后端数据已有，主要补前端/聚合）
4. **前端五件套（最划算）**：① 任务列表项挂 `+N/-N` 角标+相对时间 ② diff 内联钉在每轮回复末尾 ③ 长 diff 折叠"N lines hidden" ④ Files/Changes 双 tab ⑤ agent 提问走结构化卡片而非输入框。neo 已有 `TurnDiffSummary.tsx`/`SessionDiffSummary.tsx`/`DiffView.tsx`/`diffTracker.ts`，**数据全现成，纯前端呈现层补齐**。
5. **日/周/月 token 成本面板**：neo 的 `swarmTrace.ts`/`sessionAnalytics.ts` 已持久化 token+cost+时间戳，缺一个 `GROUP BY date()` 聚合查询 + Settings→Stats 面板。**前提动作：让普通对话(非 swarm)的每轮 usage 落库**——这是 token 经济学的真正数据地基。
6. **订阅限流窗口剩余仪表**：neo 已在 `errorClassifier.ts` 解析 `x-ratelimit-remaining` 但用完即弃；改成存进 state（升级 `agentEngine.ts` quota 类型为带数值），StatusBar 显示"剩余 N/M + 5h/weekly 双窗口重置倒计时"，避免撞限流。
7. **session 归档=释放磁盘 / restore=重建 worktree**：neo 的 archive 现在纯改 DB status、不动磁盘。借 lody 三态机——但**前置缺口**是 neo 没有 session↔worktree 显式关联（sessions 表加 `worktree_path/branch` 列）。neo 已有 `captureWorkspacePatch` 可复用做"归档前兜底"。
8. **配置保存即校验 + Test 读 capabilities**：neo 有"测试连接"按钮但只探活、且保存盲存。升级成"读回该 key 实际可用 model/mode + 保存前软校验"，把失败左移到配置阶段。

### C 档 · 增长/获客（直接对口你"用户增长 PM"的简历叙事）
9. **🌟 无缝接管 `~/.claude` / `~/.codex` 历史，一键导入续聊** —— neo 已搭好 80%：`claudeSessionParser.ts`/`codexSessionParser.ts` 能解析、`agentEngineHistoryImport` 能 list+preview，**只差三步**：(a) preview 消息 commit 进 neo SQLite (b) renderer 加 Import 入口 (c) 续聊去掉 `--no-session-persistence`、传 `--resume`。
   **这是把竞品(官方 CLI)存量用户直接虹吸的迁移钩子**——投入小、demo 炸裂，且是教科书级"产品冷启动/增长设计"案例，跟你简历主打的用户增长完全对口。**强烈建议作为 neo 下一个迭代点。**
10. **公开 roadmap + 投票反馈站**（lody 用 `feedback.lody.ai/roadmap`）—— 方法论级借鉴：需求采集飞轮 + 社区运营，替代闭门拍脑袋。
11. **一次性可吊销 token 登录 + Bearer 保护 serve + daemon 托管** —— neo 的 one-shot/`--json`/stdin/serve 已对齐 lody，唯独缺这条"远程无人值守鉴权链"，补齐才能安全进 CI/cron/远程。命中你一直关注的无人值守。
12. **worktree post-create hook**（自动装依赖/配 env）—— 这是 lody 自己 roadmap 上还没做的缺口（用户在投票），neo 既然在做 worktree 可**抢先**补上。

## 四、给你（PM）的决策

- **马上做**：C-9（接管 ~/.claude 历史）+ B-4（前端五件套）。一个是增长叙事炸点，一个是低成本高体感，都靠 neo 现成能力，一两个迭代能出 demo。
- **定方向**：A-1+A-2（daemon + CRDT 异步 review）。把 neo 从"桌面 IDE 助手"重定位成"异步 agent 协作控制台"，踩中 2026 年 agent 从"同步陪写"转"异步托管"的趋势，作品集叙事更值钱。
- **别回头看**：调度/工具/沙箱/权限/MCP/浏览器——neo 已经赢，往这些方向抄 lody 是倒退。

需要的话,我可以把 **C-9 接管历史** 或 **A 档 daemon+CRDT** 单独展开成一份带文件改动锚点的落地设计。要不要把这份竞品分析归档到记忆（code-agent 域）方便后续迭代引用？

---

下面是完整借鉴清单——把 11 个 agent 的发现全部铺开，不做优先级排序、不给"先做哪个"的判断。每条标注 lody 做法 / neo 现状(带文件锚点) / 缺口 / 借鉴动作 / 改造成本。

图例：**neo 现状** = 有 / 部分 / 无；**成本** = 低(纯前端或小改) / 中(跨层) / 高(架构级)。

---

## 第 0 部分 · 定位前提

lody = Loro CRDT 团队的 **ACP 编排壳**，自己不写工具/沙箱/skill/MCP，全甩给被托管的 Claude Code/Codex。它的全部价值在"协作神经系统 + 产品治理"层。以下清单只覆盖这一层。

---

## 第 1 部分 · neo 已领先、无需借鉴（列出以求"完整"）

| 维度 | neo 现状 | 文件锚点 | 对比结论 |
|------|---------|---------|---------|
| 多 agent 调度 | 有(完整) | `scheduler/{DAGScheduler,TaskDAG,taskDagAlgorithms}.ts` + L0-L2 + 级联取消 | lody 仅 worktree 隔离靠人盯，无依赖图 |
| 工具系统 | 有(完整) | `tools/toolExecutor.ts`(44K) + `tools/modules/` | lody 无自研工具，转发 ACP |
| 沙箱隔离 | 有(完整) | `sandbox/{manager,bubblewrap,seatbelt}.ts` | lody 仅 Linux cgroup 资源封顶，mac 上 Noop |
| 权限系统 | 有(完整) | `permissions/modes.ts`(6档) + `permissionClassifier.ts` + 决策追踪 | lody 二元 Full Access 开关 |
| MCP | 有(完整) | `mcp/`(20+文件)，4 transport + marketplace + server/client 双向 | lody 根本不做 MCP |
| 浏览器 + computer-use | 有(完整) | `plugins/builtin/{browserControl,computerUse}/` + `tools/vision/` | lody 完全没有 |
| context 健康观测 | 有(更强) | `context/contextHealthService.ts` + `ContextHealthPanel.tsx`(按 Skills/MCP/Subagents 拆分可卸载) | lody 仅一个百分比 |
| SQLite 持久化 + 崩溃恢复 | 有(更强) | `databaseService.ts`(WAL) + `SessionRepository.markCrashedActiveSessions` | lody 文档未提崩溃恢复 |
| skill 工程化 | 有(更强) | `skills/marketplace/` git 分发 + `distillExecutor.ts` 自动蒸馏 + progressive disclosure | lody 不定义 skill 格式，"共享 skill"还是 planned |

→ 这 9 项往 lody 抄是倒退。

---

## 第 2 部分 · 可借鉴清单

### A · 协作与同步层（lody 的真护城河）

**A1 — CRDT 多端实时状态同步**
- lody：用 `loro-crdt` 把对话/文件 diff/分支状态/session 建模成 CRDT 文档，桌面/Web/iOS/Android 实时合并同步，自带 undo。
- neo 现状：**无**。纯单机桌面，会话状态停在本地 SQLite。
- 缺口：换机续接、多窗口、队友围观/接管全做不了。
- 借鉴动作：引入 Loro(开源 Rust+wasm) 做会话状态同步层；neo 已有 Supabase 后端可落同步通道。
- 成本：**高**

**A2 — ACP 异构 agent 接入**
- lody：`@agentclientprotocol/sdk` + `acp-extension-claude/codex`，把任意 CLI agent 当可插拔 runtime，跟随 ACP Registry 动态加载。
- neo 现状：**部分**，有 `protocolRegistry`/`protocolToolRegistration` 骨架，但自己是 agent、未做 ACP 适配。
- 缺口：无法编排/托管外部 agent，也无法被别的壳托管。
- 借鉴动作：加 ACP 适配层，让 neo 编排器调度 Claude Code/Codex 当子 worker；MCP marketplace 经验(Discover+Test)可复用到 "ACP runtime marketplace"。
- 成本：**高**

**A3 — 团队实时协作会话（presence/接管）**
- lody：`CodeCollab` + Loro `EphemeralStore`(presence/光标) + durable SSE，多人实时围观/接管同一 agent 会话，跨设备。
- neo 现状：**无**。
- 缺口：无团队协作维度。
- 借鉴动作：依赖 A1 落地后，叠加 presence + session 接管。
- 成本：**高**（A1 之上）

**A4 — 会话上下文作为共享单位**
- lody：共享的不只是配置，是"完整 conversation context"，团队成员可见、可续。
- neo 现状：**部分**，`comboRecorder.saveAsSkill` 接近雏形，但共享单位是 skill 库，不是会话。
- 借鉴动作：让"一段调好的会话/combo"能像 skill 一样打包分发。
- 成本：**中**

### B · 移动端与异步 review

**B1 — 响应式 Web / 移动端 review**
- lody：原生 iOS/Android App，出门只带手机指挥 agent。
- neo 现状：**无**（`web/webServer.ts`+SSE 存在但是桌面镜像、无响应式）。
- 借鉴动作：最小可行版先把 webServer 输出做响应式(手机浏览器看 diff+批准)，而非直接做原生 App。
- 成本：**高**

**B2 — 异步/远程权限审批**
- lody：把 `session/request_permission` 推到手机异步处理，长任务跑着、人离开也能事后批。
- neo 现状：**无**（权限 prompt 同步阻塞）。
- 借鉴动作：neo 决策历史缓存 + 异步审批通道结合，把"必须在场盯"变"事后批一批"。
- 成本：**中**

**B3 — 批准动作下沉系统通知层**
- lody：iOS Live Activities + 灵动岛追踪 agent 进度，需批准时推 actionable Live Activity，**锁屏直接批准不用开 App**。
- neo 现状：**无**。
- 借鉴动作：PWA push / 锁屏 actionable 按钮（依赖原生能力，对 Tauri 桌面优先的 neo 性价比低）。
- 成本：**高**

**B4 — 通知即任务卡**
- lody：通知文案 = 任务名 + "Pull Request #215 is ready to review"，点进去直达 diff。
- neo 现状：**无**结构化通知。
- 借鉴动作：通知模板化(任务名+PR#+ready to review)，让通知本身成可操作入口。
- 成本：**低**

### C · 前端 / UX 呈现（neo 后端数据多已现成）

**C1 — 任务列表项挂 `+N/-N` 角标 + 相对时间**
- neo 现状：**部分**(`turnDiffSummary.ts`/`diffTracker` 有数据，列表未渲染)。
- 借鉴动作：每个 session/task 增删总数渲染到列表行右侧。成本：**低**

**C2 — diff 内联钉在每轮回复末尾**
- neo 现状：**部分**(`TurnDiffSummary.tsx` 已有，确认是否内联在 MessageBubble 末尾而非侧栏独占)。
- 借鉴动作：若在侧栏则内联进对话流。成本：**低**

**C3 — 长 diff 折叠 "N lines hidden"**
- neo 现状：**无**(`DiffView.tsx` 若全量展开)。
- 借鉴动作：只展开改动 ±3 行，其余折叠成可点条。成本：**低**

**C4 — Files / Changes 双 tab**
- neo 现状：**部分**(对应 `SessionDiffSummary` 全量 vs `TurnDiffSummary` 单轮，未拆 tab)。
- 借鉴动作：浏览文件树 / 只看本轮改动 拆两 tab。成本：**低**

**C5 — agent 提问走结构化卡片而非输入框**
- neo 现状：**部分**(有 AskUserQuestion/权限请求，呈现待确认)。
- 借鉴动作：提问/批准用卡片+明确按钮，减少"输入框打 yes"歧义。成本：**低**

**C6 — diff 行内评论 → 同步 GitHub PR Review**
- neo 现状：**无**(有 diff 数据)。
- 借鉴动作：加行级评论锚点 + GitHub API 回写。成本：**中**

**C7 — Remote Preview + 视觉标注回灌**
- lody：本地 dev server 嵌入界面(视口切换/旋转/缩放)，人点 UI 元素写评论 → "元素引用+指令"送回 agent。
- neo 现状：**无**(neo 是 agent→页面方向，缺人→agent 反向视觉反馈)。
- 借鉴动作：做"localhost 预览 + 视觉锚点批注 → 喂回 agent"闭环（比截图更结构化，锚定 DOM 元素）。成本：**中**

### D · 成本 / 配额可观测

**D1 — 每条回复显示剩余 context %**
- neo 现状：**有(更强)** `ContextUsage.tsx` + `ContextHealthPanel.tsx`。→ 反而 lody 该学 neo。

**D2 — 日/周/月 token 成本统计面板**
- neo 现状：**部分**(`swarmTrace.ts`/`sessionAnalytics.ts` 已持久化 token+cost+时间戳，但只单会话/swarm，无日历聚合)。
- 缺口：**普通对话(非 swarm)的 usage 没落库**。
- 借鉴动作：① 让每轮 completionSummary 的 tokenUsage 落库 ② `SwarmTraceRepository` 加 `aggregateByRange(start,end,granularity)`(`GROUP BY date()`) ③ 新建 Settings→Stats 面板。成本：**中**

**D3 — 订阅限流窗口剩余仪表**
- lody：Agent Config→Machines 显示订阅 5h+7d 双窗口剩余配额 + 刷新时间(机制文档未明，推断为读本地凭证+usage端点/解析 `x-ratelimit-*`)。
- neo 现状：**部分**(`errorClassifier.ts` 已解析 `x-ratelimit-remaining` 但用完即弃，只被动 429 检测)。
- 借鉴动作：把 `x-ratelimit-limit/remaining/reset` 存进 state(quota 类型从 4 状态枚举升级为带数值)，StatusBar 显示"剩余 N/M + 5h/weekly 重置倒计时"。成本：**中**

### E · session / 磁盘生命周期治理

**E1 — 归档 = 释放磁盘（保留对话+分支）**
- lody：archive 先把未提交改动 commit 到分支 → 删 worktree 工作目录释放磁盘。
- neo 现状：**部分**(`SessionRepository` archive 纯改 DB status，不动磁盘；子代理层 `agentWorktree.cleanupAgentWorktree` 有"无变更删、有变更存 patch"逻辑可复用)。
- 借鉴动作：archiveSession 联动 worktree——先 `captureWorkspacePatch`(已有) → `git worktree remove`。成本：**中**

**E2 — restore = 自动重建 worktree**
- neo 现状：**无**(`sessionManager.restoreSession` 只 reload 回运行态，不重建 worktree)。
- 借鉴动作：检测 worktree 已不在则从分支/patch 自动 `git worktree add`。成本：**中**

**E3 — session ↔ worktree 显式关联（E1/E2 的地基）**
- neo 现状：**无**(sessions 表只有 `git_branch` 元数据，无 worktree 路径/分支)。
- 借鉴动作：加 `worktree_path`/`worktree_branch` 列，让生命周期可联动。成本：**中**

**E4 — delete 触发异步 machine-side cleanup**
- neo 现状：**部分**(delete 纯软删 `is_deleted=1`，worktree 靠 1h 孤儿惰性回收)。
- 借鉴动作：delete 入队清理任务回收关联 worktree+runtime。成本：**中**

**E5 — DB/磁盘 retention 治理**（neo 自身缺口，非抄 lody）
- neo 现状：**无**(无 VACUUM、软删行永不物理回收、孤儿 worktree 只惰性回收)。
- 借鉴动作：定时 VACUUM + 软删物理回收 + 启动时/定时孤儿 worktree 清理。成本：**中**

### F · headless / CI / 无人值守

**F1 — 一次性可吊销 Token 登录**
- lody：`lody login --auth <token>`(Settings 生成、只显示一次、可吊销、即时失效) + `LODY_AUTH` env。
- neo 现状：**无**(只有 `ANTHROPIC_API_KEY` 等 env / `.env`，`/login` 仅交互 chat 模式)。
- 借鉴动作：加 `code-agent login --token` 写 `~/.code-agent/credentials.json` + `CODE_AGENT_AUTH` env。成本：**中**

**F2 — serve 加 Bearer 鉴权 + 并发**
- neo 现状：**部分**(`serve` 命令暴露 `/api/run`(SSE) 等，但无鉴权、单任务 409、`--host 0.0.0.0` 裸奔)。
- 借鉴动作：`/api/run` 校验 Bearer token，单任务 409 改按 sessionId 排队/多 worker。成本：**中**

**F3 — daemon 子命令**
- lody：`lody daemon start/status/logs/stop/restart`，日志 `~/.lody/logs`。
- neo 现状：**无**(serve 是前台单进程，远程托管要自己包 systemd/pm2)。
- 借鉴动作：`code-agent daemon start/stop/status/logs`，detach + pid/日志。成本：**中**

**F4 — 全局 `--timeout`**
- neo 现状：**无**(CI 要外层 `timeout` 包)。借鉴动作：run/serve 加超时自杀。成本：**低**

**F5 — 工效对齐（已大半具备）**
- neo 现状：**有** one-shot `code-agent run`、stdin 喂 prompt、`--json/--output-format/--output-schema`、`-s/--session`、非交互安全默认、`--metrics`。
- 缺口小项：`--prompt-file <path>`、`CODE_AGENT_SESSION_ID` env、远程会话只读命令(`session list/history/show` 走云 API)。成本：**低**

### G · 历史接管 / 迁移获客

**G1 — 无缝接管 `~/.claude` / `~/.codex` 历史，一键导入续聊**
- lody：Settings→Projects 手动 sync，侦测本机已装 agent，导入历史并跨设备续聊；新对话回写 CLI(双向镜像)。
- neo 现状：**部分(80% 地基)**——`claudeSessionParser.ts`/`codexSessionParser.ts` 能解析、`agentEngineHistoryImport` 能 list+preview；类型层 `agentEngine.ts` 已声明 `import_sessions/resume/origin:'import'` 但**无实现**(近 dead code)；adapter 硬编码 `--no-session-persistence` 不传 `--resume`。
- 借鉴动作：① preview 消息 commit 进 neo SQLite ② renderer 加 Import 入口 ③ 续聊去掉 `--no-session-persistence`、传 `--resume`(单向导入续聊即够；双向回写可作 roadmap 占位)。
- 成本：**中**（单向）/ **高**（双向）

**G2 — local-project 跨端同步 + CLI 历史回写**
- lody：本地目录接入后跨端同步，lody 内对话回写对应 CLI 保持一致。
- neo 现状：**无**(纯单向只读，对 `~/.claude`/`~/.codex` 零回写)。
- 借鉴动作：依赖 A1(CRDT) + G1 落地后扩展。成本：**高**

### H · 配置 / onboarding

**H1 — Test 能力自检（保存前校验 + 读 capabilities）**
- lody：配 agent 填完保存前点 Test，验证能拉起 runtime 并读到支持的 model/mode，失败左移到配置阶段。
- neo 现状：**部分**(`providerConnectionTest.ts` 有"测试连接"但只 1-token 探活/GET models、且保存盲存不校验；外部 agent `agentEngineRegistry.probeCommand` 只 `--version` 探装没装)。
- 借鉴动作：Test 返回该 key 实际可用 model/mode 列表存进配置 + `handleSave` 前软校验(失败非阻塞警告)。成本：**中**

**H2 — daemon 自动探测已装 CLI 建默认 config**
- lody：daemon 自动侦测本机 Claude Code/Codex 并建默认 agent config。
- neo 现状：**需确认**(有 `probeCommand` 探测，是否自动建默认 config 未核实)。
- 借鉴动作：首启自动探测+生成默认配置，降低 onboarding 摩擦。成本：**低**

### I · 产品运营 / 合规 / 可观测

**I1 — 公开 roadmap + 投票反馈站**
- lody：`feedback.lody.ai/roadmap` GitHub 登录、用户提 issue/投票、三态看板。
- neo 现状：**无**。
- 借鉴动作：方法论级——需求采集飞轮 + 社区运营，替代闭门决策。成本：**低**（运营动作，非代码）

**I2 — 安全合规 + 可观测基线**
- lody：隐私政策 + 子处理方清单(Cloudflare/Convex/GitHub/PostHog/Sentry) + 30 天数据删除 + export 权利；Sentry 错误监控 + PostHog 产品分析。
- neo 现状：**需确认/大概率无**(对外发布所需)。
- 借鉴动作：对外/团队发布前补"子处理方清单 + 删除流程 + Sentry+PostHog 双监控"模板。成本：**中**

### J · worktree 增强

**J1 — worktree post-create 初始化脚本**
- lody：**自己还没做**(roadmap 上用户投票要——新 worktree 自动跑装依赖/配 env)。
- neo 现状：**无**(隔离出新分支但 `node_modules`/`.env` 不在)。
- 借鉴动作：worktree 加 post-create hook 脚本——可**抢先于 lody** 补上。成本：**低**

### K · 其他零散功能点（lody 有、值得记录）

| # | lody 功能 | 源 | neo 现状 | 成本 |
|---|----------|-----|---------|------|
| K1 | 会话内全文搜索(消息/思考/工具调用/终端/diff，Cmd+F) | `/docs/session-search` | 需确认 | 中 |
| K2 | 多 session 标签(主+子对话+文件预览+diff 同 task) | `/docs/session-tabs` | 需确认 | 中 |
| K3 | session 导出(JSON/MD/附件/用量) | `lody export` | **有** `code-agent export` | — |
| K4 | Git 身份分离(GitHub App 仓库权限 vs 个人身份做 PR/merge) | `/docs/github` | 无 | 中 |
| K5 | 多模态：image input/output、@mention、slash-commands、copy-md | `/docs/*` | 部分(需逐项确认) | 低-中 |
| K6 | PR 闭环：自动建 PR + CI 状态 + review 评论同步 | `/docs/github` | **部分**(neo 只读 `gh pr view`，无 create/comment/CI) | 中 |
| K7 | GitHub 集成 daemon 常驻 + 完成推送 | `/docs/notification` | 无 | 中 |

---

## 附 · 源索引

- lody 官网/文档：`lody.ai` · `/docs`(quickstart/cli/cli-runtimes/agents/worktrees/session/github/diff-viewer/diff-comments/local-project/usage-and-quota/quota/notification/mobile/preview/team/session-search/session-tabs) · `/changelog` · `/blog/introducing-lody`
- 公开 roadmap：`feedback.lody.ai/roadmap`
- 技术底座：npm `lody@0.62.0`(反编译) · `loro.dev`(CRDT) · `agentclientprotocol.com`(ACP)
- neo 对照：`/Users/linchen/Downloads/ai/code-agent` 各文件路径见上文

---

清单完。**neo 已领先 9 项 + 可借鉴约 35 个点（A-K）**，全部标了文件锚点和成本，没做任何取舍。

---

## 三档分类（PM 初判）

> 上面的清单刻意没排优先级，这里补三档判断。口径：ROI × 与 neo 真实栈契合度（Tauri 桌面 / 单机自用 / 求职作品集）× 风险。

- **✅ 值得借鉴**：G1 接管历史一键续聊（80% 已建成，增长叙事炸点）、C1–C5 前端五件套（数据现成纯前端）、D2 token 成本面板 + 让普通对话 usage 落库、E5 DB/磁盘 retention 治理、J1 worktree post-create hook、B4 通知即任务卡、F4/F5 CLI 小项
- **🟡 待讨论**：A1 CRDT 会话状态层（高成本架构，需 ADR）、B1 移动端异步 review + headless daemon（重定位押注，先做响应式 Web）、A2 ACP 适配层、E1/E2/E3 session↔worktree 生命周期、F1/F2/F3 daemon+token 登录+Bearer、D3 限流仪表、C7 remote preview、B2 异步权限审批
- **❌ 不建议/低优先**：9 项已领先（别倒退抄）、A3 团队 presence / A4 会话共享 / C6 行内评论同步 PR / K4 Git 身份分离（团队向，单机收益低）、B3 iOS 锁屏批准（Tauri 桌面性价比低）、G2 双向回写（依赖 A1）、I1 公开 roadmap（运营非工程）、I2 合规（仅对外发布时）

## 多模型评审修订（Codex + Gemini，2026-06-16）

> 把上面的三档丢给 Codex（艾克斯）+ Gemini 独立交叉评审后的修订。真·Kimi 端点当时不可达（`cn.haioi.net` 503 / 官方 key 401），第二票由 Gemini 顶。

**对本文件的修正：**

- **A1 CRDT 会话层：从 🟡 降为 ❌（两票一致）。** 对单机自用 + 求职导向是"架构毒药"，收益（多端协同）与 neo"单机沙箱"定位冲突，状态同步调试成本高。真正该借的是 session/worktree/PR/review 的**单机闭环**，不是先押 CRDT。
- **C1–C5 前端五件套：别整包列 ✅。** 搜索/筛选/成本视图是真价值；纯装饰性状态面板降一档。面试官更看重 DAG 调度与沙箱安全，别先砸面子工程。
- **B4 通知即任务卡：✅ → 🟡。** 没有 daemon + 生命周期闭环时只是前端包装，先有里子再有壳。
- **B1/B2 headless daemon + 异步远程审批：价值被我低估（Gemini）。** 它是 neo **真沙箱 + Computer Use 的绝配**——长任务沙箱里跑、人不守屏，手机远程批一个高危权限弹窗，瞬间拉开和普通"Web-UI 壳子"的差距。
- **G1 接管历史：略被我高估（Codex）。** 叙事强，但落地依赖导入质量、去重、来源解释、权限边界，有脏活。

**依赖陷阱（评审新增）：**

- **先有 spine 再谈花活**：A1 CRDT / B1 移动 review / G2 双向回写**全部依赖 maka 侧的稳定事件 spine + 身份模型 + 权限审计**。顺序反了会"把同步管道问题包装成产品亮点"，debug 成本爆炸。→ 见 `maka-agent-借鉴清单.md` 的 P0-1 事件账本（已被一致拔高为必做）。
- **G1 只读，别做成 G2**：单向只读导入续聊就够拿增长价值；双向回写会因 Claude 私有格式/加密升级拖垮 neo 稳定性，**强烈建议不回写**。

**三方合并"只做 3 件事"**（跨 maka/lody）：

| 排序 | 项 | 票 | 理由 |
|---|---|---|---|
| 1 | **G1 接管 `~/.claude`/`~/.codex` 历史（只读续聊）** | 全票 | 低成本、增长炸弹、虹吸官方 CLI 存量用户 |
| 2 | **maka P0-1/P0-3 事件账本 + spine**（配 P0-4 watchdog） | 艾克斯 + Gemini | 多 agent 调度的工程底座，可审计可回放 |
| 3 | **maka P1-7 权限弹窗 + P1-3 凭据掩码哨兵**（打包 P2-2 静态门） | 全票 | 把安全/工程治理做成面试官肉眼可见的 UI |
