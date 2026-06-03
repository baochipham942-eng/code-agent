# Agent Neo 竞品调研与优化方向报告

> 调研日期：2026-06-02
> 调研对象：扣子 Coze 3.0、codeg (xintaofei/codeg)、Cumora、Slock.ai、Deux (harness.today)
> 调研方式：Coze/Cumora/Slock/Deux 走社区+官方信息，codeg 读源码；Agent Neo 现状基于 v0.16.89 仓库盘点
> 坐标系：**cowork 人机协作产品**（对标 Manus / Cumora / Coze 3.0 这类协作产品，不套编程 IDE 框架）

---

## 一、Agent Neo 能力现状摘要（v0.16.89）

### 已经很强的（护城河）

| 维度 | 现状 |
|------|------|
| **执行深度** | 108 个工具（9 大类）、OS 级沙箱（seatbelt/bwrap）、LSP、Vision OCR、Photos connector、Managed Browser、in-app HTML 验证 |
| **多 agent 编排** | parallelAgentCoordinator（DAG 依赖调度）+ Dynamic Workflow（命令式 JS 脚本，5 原语，2026-05-29 上线）+ 声明式 stage-DAG 并存 |
| **多模型路由** | 14+ provider、成本自适应降级（实测降 60%）、provider 健康检测、本地 Ollama |
| **产物（Artifact）** | Chart / Spreadsheet / PPT Deck / Game / Dashboard / Live Preview，带 runtime verifier 和质量回流 |
| **桌面集成** | Appshots（双击 Cmd 截屏+OCR）、Vision 人脸聚类、菜单栏快速启动 —— 云端产品做不到的本地能力 |
| **评测体系** | Swiss Cheese 框架 132→164 用例、失败根因三路归因、replay 复盘 —— **已超过 Coze Loop 的概念覆盖** |
| **扩展体系** | MCP（双协议）+ Skill（三层热加载）+ Hook（4 类执行器）+ Plugin v2 |
| **隐私/本地化** | 本地 API Key、零云代理、数据不出本机 —— 对国内合规和隐私敏感用户是硬差异 |

### 明显的短板（对照竞品后）

| 短板 | 说明 |
|------|------|
| **Agent 纯被动** | 只会等用户发消息，没有任何主动性（定时醒来、主动观察、主动发起话题） |
| **组织单元是"会话"不是"项目"** | 长周期目标、多 agent、文件、产物没有统一容器，散落在 session 里 |
| **没有移动端/远程遥控** | 长任务跑着，人离开电脑就失联；Web Server 只是技术能力不是产品形态 |
| **多 agent 协作过程不可见** | SwarmMonitor 是任务进度视角，看不到 agent 之间的"讨论过程" |
| **可观测性回传未闭环** | Sentry/PostHog/Admin Console 都在 P1-P3 进行中 |
| **单人产品** | 没有多人协作概念（邀请真人进 workspace） |

---

## 二、竞品调研结论

### 2.1 扣子 Coze 3.0（2026-06-01 刚发布）—— 最大战略威胁

**定位转向**：从 "Agent 开发平台" → "**新一代 AI 团队**"。

| 能力 | 内容 |
|------|------|
| **项目空间** | 目标 + 真人成员 + Agent + 文件 + 过程产出，统一容器 |
| **Agent 4 种来源** | 原生搭建 / **接入本地 Agent（Claude Code、Codex CLI、OpenClaw）** / 云端 Agent（扣子云电脑）/ 职业模板一键生成 |
| **全端同步** | iOS/Android/macOS/Windows/Web，任务跨端接力 |
| **垂直技能包** | 金融/自媒体/法律/医疗/科研/电商 行业专家包 |
| **专项项目** | 编程项目（多人协作）、视频项目（Seedance 2.0 对话式迭代） |
| **Coze Loop** | 开源 AgentOps：Prompt 开发 / 评测（评测集+评估器+实验）/ 全链路 Trace |
| **生态** | 200+ 官方插件、Coze Studio 开源 20.9k stars |

**⚠️ 战略信号**：Coze 3.0 明确支持把 Claude Code / Codex / OpenClaw 这类本地 agent **当成员收编进它的项目空间**。它要做编排层，把 Neo 这类产品变成它的 worker。

### 2.2 codeg —— 技术栈最贴脸的对照组（Tauri 2 + React，1.5k stars）

**定位**：多 agent 编码工作台/聚合器。自己**不持有 agent loop**，通过 ACP（Agent Client Protocol）实时拉起并驱动 Claude Code / Codex / Gemini CLI / OpenCode / OpenClaw / Cline 六个 CLI agent。

**最值得借鉴的 5 个设计**（均有源码证据）：

1. **`codeg-mcp` 注入式委托**：per-launch stdio MCP 伴生进程，向被驱动 agent 暴露 `delegate_to_agent` / `get_delegation_status` / `cancel_delegation` 三件套。异步返回 task_id、可取消、可跨 agent 类型委托。
2. **委托深度防爆栈**：`depth.rs` 沿 parent 链计算深度并饱和截断，防止子 agent 无限递归 spawn。
3. **孤儿进程回收**：`parent_watcher.rs` 跨平台探活（Unix `kill(pid,0)` / Windows `GetExitCodeProcess`），父会话死亡立即 teardown 子 agent。
4. **结构化失败码**：`depth_limit` / `spawn_failed` / `child_refusal` / `child_max_tokens` / `canceled` 作为 first-class 状态回传给父 agent 的 LLM 决策。
5. **Chat Channels 远程遥控**：Telegram / 飞书 / 微信 iLink 适配器，手机上建任务、发 follow-up、审批权限、resume 会话、收实时 tool-call。
6. **experts.toml**：把 superpowers 方法论（brainstorming/TDD/debugging 等 12 条）打包成 UI 可选的 expert 人格。

**它的局限**：不持有 loop → 能力天花板被上游 CLI 锁死；委托是 one-shot 单轮；强依赖用户装好一堆 CLI。**Neo 自研 loop 是相对它的护城河。**

### 2.3 Cumora —— 定位最重叠的直接竞品（早期 preview，v0.1.61）

**定位**："Where agent teams gather" —— "像 Slack，不像 ChatGPT"。Electron 桌面 + Web + iOS（即将）。

**核心差异化**（全部是 Neo 没有的）：

| 能力 | 说明 |
|------|------|
| **Agent 主动性** | 基于 cadence 定时醒来，自主决定 DM 某人、发想法、拉小组讨论。"你停止说话，你的团队还在思考" |
| **Agent 有社交状态** | 私有 workspace + "climate"（对每个合作者的感受）+ online/offline 状态 |
| **Whisper rooms** | 旁观 agent 之间的讨论而不加入（让研究员和设计师先吵明白再呈给你） |
| **Convene rooms** | Agent 主动拉决策会议：相关人 + 议题 + 决策记录 |
| **Personas** | 4 个预设角色（研究员 Atlas / 设计师 Iris / 工程师 Bram / PM Nova），可编辑/解雇/招新 |
| **多人 workspace** | 邀请真人，agent 编成 "companies" |

**它的局限**：执行深度几乎为零 —— 官网没有工具/MCP/沙箱/终端任何字眼。**它有"协作的壳"，Neo 有"执行的核"。**

### 2.4 Slock.ai —— 协作层做得最深的同品类竞品（2026-05-21 发布）

**定位**："Where humans and AI agents build together" —— Slack 式实时聊天工作区，人和 agent 在 channel/DM 里作为**平等队友**共存。Web 控制台（app.slock.ai）+ 本地 daemon（`npx @slock-ai/daemon`）混合架构：agent 跑在用户自己机器上，代码不出本机；用户自带 API key，Slock 不卖 token，卖协调层。

**核心能力**：

| 能力 | 说明 |
|------|------|
| **Agent 持久身份** | 一个 agent = 一个 session = 持续身份，跨天跨任务存活，有自己的 `MEMORY.md`（`~/.slock/agents/<id>/`） |
| **无中心编排** | Agent 从 task board **自主认领**任务（`slock task claim` + 协议级硬锁防冲突），没有中心 orchestrator |
| **Runtime 复用** | daemon 扫描 PATH 自动发现 claude/codex/gemini/opencode，把已装 CLI 变成可派发 agent |
| **Agent 自主性** | Agent 给自己设提醒、管理自己的时间、主动加入 channel 接任务（"proactive, not programmed"） |
| **多人协作** | Server → Channel → DM → Thread，真人和 agent 共享同一上下文 |

**⭐ 最重要的发现：AX（Agent Experience）设计学科**。Slock 系统化回答了"多 agent 同处一室为什么混乱"——agent 是回合制的（读快照→推理→提交动作），推理期间房间状态变了，它就在对一个已不存在的状态行动。业界通行解法（@mention 门控、channel 隔离、allowlist）的本质是把 agent 打回成等待被调用的工具。Slock 给出两个设计原语：

1. **Agent Inbox（pull 模型）**：通知不推给 agent，变成可查询的 item，agent 有带宽时自己 pull、自己决定什么值得进上下文。"让 agent 决定什么占用它的 context，而不是让下一个发消息的人决定。"
2. **Held Draft（新鲜度检查）**：每条待发消息标记"针对哪个房间版本写的"，发送时房间已变 → hold 退回 agent 附变更说明，agent 四选一：重写 / 照发 / **沉默（合法结果）** / 知情强发。

**它的软肋**：极早期（发布约 2 周）、闭源不可自托管、国内访问 console 要 VPN、无可视化项目管理（纯 chat）、无移动端、本地 daemon 长跑有运维门槛。

**用户信号**：Ed Huang（PingCAP CTO）证言"我不再写代码了，我是 Agent Resource Manager，峰值一天 12 亿 token"——国内技术圈已有真实早期采用。

### 2.5 MuleRun Messages（阿里云）—— 大厂进场信号（2026-06-03 补充）

**定位**：阿里云 MuleRun Enterprise 的 AI 协作 IM（2026-06-02 上线）。人↔人、人↔Agent、Agent↔Agent 三种交互在同一空间；Agent 可被 @、被拉群、"长期在岗"；线程为协作单元，多线程并行。

**两个新原语**：
1. **跨人 Agent 访问**——"Alice 可以直接与 Bob 的 Agent 对话"，Agent 从个人助理变成组织资产。Slock/Cumora 都没做这个。
2. **企业 IM 形态分发**——长在企业通讯录上，不要求用户换工作区。

**时间线信号**：05-21 Slock（创业）→ 06-01 扣子 3.0（字节）→ 06-02 MuleRun Messages（阿里云）。48 小时内两个大厂进场，路线②（聊天室共处型）已成大厂主战场。

**对 Neo 的战略修正**：协作层的形态不要正面做群聊 IM（拼不过大厂分发），做"本地执行深度 + 最小够用的协作层"（项目空间 + 主动性 + 定点反馈）——所有进场大厂都是云架构，本地桌面深度（Appshots/Vision/本地文件/沙箱）没人能碰。

### 2.5b 补充：WorkBuddy（腾讯）与 Codex for Every Role（OpenAI）—— 2026-06-03

**WorkBuddy（腾讯云，CodeBuddy 同底座，3 月上线 5 月出海）**：桌面优先的 AI 工作台，"专家中心 + 召唤专家 + Expert Teams"（主控 agent 拉并行子 agent）。专家是预置角色库、即用即走、无持久身份。被称为"腾讯版 OpenClaw"。至此**三朵国内云全部进场**。

**Codex for Every Role（OpenAI）**：与所有"专家 Agent"打法**根本不同的抽象**——产品单元不是 agent 人格而是 **role plugin（装备包）**：6 大角色插件（数据分析/创意/销售/产品设计/股权投资/投行）= 62 个 SaaS 连接 + 110 个 skills 按角色打包。Agent 永远是同一个 Codex，只换装备。生态打法："partners can create and deploy their own plugins"。非开发者用户占 20%、增速是开发者 3 倍。

**两种抽象的本质**：专家 Agent 卖"人"（人格单元，护城河弱——人设就是 prompt），Codex plugin 卖"装备"（工具集成 + 领域知识，护城河强——SaaS 生态）。两者不互斥，是上下层：完整形态 = 有人格的专家 + 按角色打包的装备。

**对 Neo P2-2 的升级**：垂直技能包不只打包 skills，要把"连接器 + skills + 人设"打成完整角色包——Neo 的 custom agent / Skills / MCP connector 三层架构天然支持这个组合，缺的只是打包和分发这个产品动作。

### 2.6 Deux (harness.today) —— 不是直接竞品，但底层 harness 值得看

**定位**：独立开发者 Hwang（@hwwaanng，AFFiNE 早期成员，上海）的 macOS 垂直工具——把 iOS 代码库（Swift/SwiftUI）自动迁移成原生 Android（Kotlin/Compose）。作者自称 POC/MVP，是他近几周发布的 11 个 side project 之一。$199 早鸟价，pre-launch。底层用 OpenAI Codex（嫌 Claude rate limit 苛刻），单次迁移最长跑 9 小时。

**为什么还值得看**：它的 landing page 暴露了底层是一个**通用 multi-agent harness**（域名就叫 harness.today），这部分比迁移功能更接近 Neo：

- **Manager + 命名 subagents**（Popper / Dirac / Ptolemy）+ 实时状态流（"Waiting for 1 subagent" / "Planning completed. No product code modified."）
- **team.md 配置 + Skills 面板 + Recent 任务列表**
- **Plan gate**：代码生成前先产出完整迁移计划，用户可 approve / adjust / override —— 把不可逆大动作卡在人工闸门前

**结论**：Deux（迁移工具）本身不构成竞争压力，但 "Manager→命名 subagent 可视化编排 + 可审查计划闸门" 是 Neo 多 agent UI 的好参考。

---

## 三、差距矩阵

| 能力维度 | Neo | Coze 3.0 | codeg | Cumora | Slock | Deux |
|----------|-----|----------|-------|--------|-------|------|
| 执行深度（工具/沙箱/产物） | ⭐⭐⭐ | ⭐⭐ | ⭐（依赖上游） | ✗ | ⭐（依赖 runtime） | ⭐⭐（单一垂直） |
| Agent 主动性 | ✗ | ⭐ | ✗ | ⭐⭐⭐ | ⭐⭐⭐（自管时间） | ✗ |
| 项目/团队容器 | ✗（仅 session） | ⭐⭐⭐ | ⭐ | ⭐⭐ | ⭐⭐（channel/server） | ⭐（workspace） |
| 多 agent 协作可见性 | ⭐（任务进度） | ⭐ | ⭐ | ⭐⭐⭐（讨论过程） | ⭐⭐⭐（chat 即过程） | ⭐⭐（状态流） |
| 多 agent 交互层设计（防混乱） | ✗ | ✗ | ⭐（depth/锁） | ⭐ | ⭐⭐⭐（AX 原语） | ⭐ |
| 移动/远程遥控 | ✗ | ⭐⭐⭐ | ⭐⭐（IM 遥控） | ⭐⭐ | ⭐⭐（Web console） | ✗ |
| 接入外部 Agent | ⭐⭐（agentEngine 已支持 Codex/CC） | ⭐⭐⭐ | ⭐⭐⭐（ACP） | ✗ | ⭐⭐⭐（PATH 扫描） | ✗ |
| 多人协作 | ✗ | ⭐⭐⭐ | ✗ | ⭐⭐ | ⭐⭐⭐ | ✗ |
| 评测/可观测 | ⭐⭐⭐（本地闭环） | ⭐⭐（Coze Loop） | ✗ | ✗ | ✗ | ✗ |
| 本地化/隐私 | ⭐⭐⭐ | ✗（云为主） | ⭐⭐⭐ | ⭐ | ⭐⭐（执行本地/console 云端） | ⭐⭐⭐ |
| 生态规模 | ⭐ | ⭐⭐⭐ | ⭐ | ✗ | ✗ | ✗ |

**结论一句话**：Neo 的"执行的核"是六家里最强的，缺的是"协作的壳"——主动性、项目容器、远程遥控、协作可见性，以及多 agent 共处时的交互层设计（AX）。

**品类格局**：cowork 赛道已形成三条路线——
① **平台收编型**（Coze 3.0）：云端项目空间收编一切 agent；
② **聊天室共处型**（Slock / Cumora）：agent 是有持久身份、会主动的队友；
③ **桌面深度执行型**（Neo / codeg）：本地工具深度 + 编排。
Neo 在路线③里执行深度第一，但路线②证明了"agent 有身份、会主动"才是 cowork 体感的来源——这是 Neo 最该补的。

### 统一框架：两条正交的轴

把六家产品放到一个框架里看，所有"多 agent"玩法其实是两条轴的组合：

**轴一：协作结构（subagent vs 队友）**

工程上都是"spawn 一个带工具的 LLM loop"，但产品上有三个真分野：

| 维度 | Subagent（Neo 现状 / codeg / Deux） | 队友（Slock / Cumora） |
|------|-------------------------------------|------------------------|
| 生命周期 | 任务起、任务死 | 跨任务跨会话持久存在 |
| 触发方向 | 永远被上级调用 | 能自己醒来、自己发起 |
| 记忆归属 | 没有自己的记忆 | 有自己的 MEMORY.md、自己的身份 |

**队友 = 持久化的 subagent + 自触发 + 自有记忆**。Neo 引擎已具备（SubagentExecutor + custom agent + Light Memory），缺的是把三个属性绑定起来的产品层。

**轴二：能力分配（单模型 vs 多模型互补群聊）**

每个成员背后用哪个模型大脑。多模型群聊的价值 = 补强单 provider 的能力短板：研究员用搜索强的模型、工程师用 Claude/Codex、数据分析用 DeepSeek、中文内容用 GLM。模型分歧本身就是交叉验证（multi-review 模式的产品化）。

**Neo 的独占机会**：六家里只有 Neo 同时握着两条轴——Slock/Cumora 没有模型路由（用啥 CLI 就啥模型），Coze 绑死火山系，codeg 依赖上游 CLI。Neo 的 14+ provider 路由现在是看不见的管道（成本优化），群聊化之后能变成看得见的产品卖点："你的 AI 团队里每个同事的大脑都不一样，而且他们会互相挑错。"

**约束**：纯 chatbot 群聊（无执行）是娱乐品类；群聊成员一多就撞 AX 混乱问题。落地形态 = 少量有角色的多模型队友 + 执行能力 + 发言纪律（AX 原语），不是开放群聊。

---

## 四、应用层总纲：以产物为中心（2026-06-03 拍板）

竞品的三种应用层抽象——平台收编（Coze）/ 聊天室队友（Slock/Cumora/MuleRun）/ 角色插件（Codex）——全部是"**以 agent 为中心**"的：它们在回答 agent 怎么组织、怎么交互、怎么装备。

**Neo 的应用层抽象是第四种：以产物为中心。** 产物是一等公民，agent 围着产物转。

**三个理由**：
1. 用户真正在乎的是产物（报告/PPT/网页）有没有变好、怎么变好、能不能随时介入——agent 只是手段。协作工具史也验证：Slack（消息中心）做不了深度协作，Notion/Figma（产物中心）做到了
2. 以产物为中心需要本地渲染 + 文件系统深度——云端大厂以账号/消息/组织为中心是基因决定的，做不了
3. Neo 的 artifact 体系（Deck/Spreadsheet/Dashboard/Game + runtime verifier + 质量回流）是七家竞品里唯一的产物中心底子，且"产物为主轴"本来就是 Neo 的定位

**应用层形态**：用户打开 Neo 看到的不是 agent 列表、不是聊天窗口、不是插件市场，而是"**我的项目 + 它的产物们**"——每个产物有迭代历史、可定点反馈、有质量状态；agent 在产物背后工作，需要介入时才浮现；聊天是产物旁的批注，不是组织主轴。

**三种竞品抽象的合理部分作为配件被吸收**：
- 项目空间 = 容器（来自平台收编）
- @agent / 群聊 = 输入方式（来自聊天室队友）
- 角色装备包 = 能力供给（来自角色插件）

---

## 五、优化方向建议（挂在产物中心总纲下）

### P0-1 Agent 主动性 + 持久身份（借鉴 Cumora + Slock）

**产物中心下的重新表述**：主动性不是"agent 主动找你聊天"，而是"**产物在你不在的时候继续变好，并把变化告诉你**"——主动性的载体是产物迭代，不是消息。

**为什么是 P0**：这是 cowork 和 chatbot 的分水岭。"协作者"和"工具"的区别就在于会不会主动。Cumora 和 Slock 都把这个做成了核心卖点（Cumora："你停止说话，你的团队还在思考"；Slock：agent 给自己设提醒、自己管理时间），而 Neo 完全没有。

**两个子能力要一起做**（Slock 证明了它们是一体的），但表述按黄佳的终局判断修正（2026-06-03）：

> 黄佳（《Claude Code 工程化实战》14b/08 评论区）："终局是云端 agent OS + 每用户隔离 runtime + skills/subagents 作为能力插件"、"未来绝大多数场景是 Harness 根据情况自动创建并清理 Agent" —— 即 agent 实例是瞬时的，不是常驻队友。

**合成：持久的是资产（记忆 + 角色定义），瞬时的是实例（运行中的 agent）。** 角色和记忆是户口，实例是上班。

1. **持久资产**：一个角色 = 角色定义 + 专属记忆文件，跨会话跨任务存活；运行实例由 harness 按需拉起、用完清理 —— Neo 的 Light Memory + custom agent 机制天然适配，缺的是把两者绑定成"这个角色的记忆"
2. **主动行为**：定时实例化角色（带上它的记忆）→ 检查产物状态 → 推进/汇报/沉默 → 实例销毁

**怎么做**（Neo 已有的积木够用）：
- Hook 系统已有 4 类执行器 → 加一个 **cadence/timer 触发器**（定时醒来）
- Light Memory 已有会话摘要 → 醒来时让 agent 读最近上下文 + 项目状态，自主决定：继续推进任务 / 汇报发现 / 提出建议 / **保持沉默（合法结果，借 Slock 的设计）**
- 产品形态：可配置的"主动等级"（静默 / 每日简报 / 实时介入），默认每日简报
- MVP 切口：长任务跑完后 agent 主动总结 + 提出 next steps，而不是干等用户回来

### P0-2 项目空间容器（借鉴 Coze 3.0 + Cumora）

**产物中心下的重新表述**：项目空间的中心视图不是"成员列表"（Coze 的做法），而是"**产物列表**"——项目 = 目标 + 产物集 + 围绕产物工作的 agent。

**为什么是 P0**：Coze 3.0 和 Cumora 都把组织单元从"会话"升到了"项目/房间"。cowork 的本质是围绕**长周期目标**协作，session 这个单元装不下。

**怎么做**：
- 新增 Project 实体：目标（goal）+ 关联 sessions + agents + 文件 + artifacts + 决策记录
- 这正好和已设计的 **/goal 三层闸完成判定**（project_agent_neo_goal_mode）合流——goal 不只是一次 run 的完成判定，而是项目空间的持久目标
- Workspace Preview 面板已有 artifact 聚合 → 升级为项目维度聚合
- DB 层 sessions 表加 project_id 外键，渐进迁移

### P1-1 移动遥控 / Chat Channels（借鉴 codeg）

**为什么是 P1**：cowork 的真实场景是"长任务跑着，人去开会了"。codeg 已给出 Telegram/飞书/微信三个适配器的工程范例，爸自己的 OpenClaw 也有飞书推送经验，复用成本低。

**怎么做**：
- MVP：飞书 bot 单通道 —— 任务状态推送 + 手机回复 follow-up + 权限审批（approve/deny）
- Web Server（SSE）已有 → 加一个 channel adapter 层桥接到飞书 webhook
- 这和 Fleet Observability 的推送基础设施可以共用

### P1-2 Swarm 工程护栏补齐（借鉴 codeg + Cline Kanban）

**为什么是 P1**：Neo 的 Dynamic Workflow 刚上线，codeg 和 Cline Kanban 踩过的坑可以直接抄答案，成本极低、防患于未然。这些是执行层基础设施，与上层协作拓扑（看板隔离 / 群聊共享）正交——只要多 agent 并行改同一仓库就都需要。

**清单（来自 codeg 源码）**：
- ✅ 已有：provider 并发闸、token 预算、cancel 级联
- ❌ 补：**委托深度饱和截断**（防递归 spawn 爆栈）
- ❌ 补：**孤儿进程回收**（父会话死亡 → 子 agent teardown，跨平台探活）
- ❌ 补：**结构化失败码**（child_refusal / child_max_tokens / depth_limit 作为 first-class 状态回传给编排层决策）

**清单（来自 Cline Kanban，2026-06-03 补充并经代码核实，前两项已实现 → [PR #203](https://github.com/baochipham942-eng/code-agent/pull/203)）**：
- ✅ **已实现：worktree 间 gitignored 目录 symlink 共享**（PR #203，commit a60ec2d26）—— 解析主仓 `.gitignore` 顶层目录条目 symlink 回主仓，best-effort
- ✅ **已实现：任务取消/丢弃前的 patch 快照**（PR #203，commit d217f3016 + f2364dcee）—— taskPatchService 落盘 `~/.code-agent/trashed-task-patches/`，接入 subagent abort / workflow run cancel / worktree 清理三条链路。附带发现并修复 macOS orphan worktree 清理 no-op 既存 bug；附带发现 workflow run 删除是死代码（无产品入口），安全网做到 service 层待接
- ❌ 补：**定点反馈 loop（locality-anchored feedback）**（这条升格为产物中心的核心交互原语，优先级实质上是 P0） —— Cline Kanban 的形态是在代码 diff 某一行留 comment，comment 直接变成喂给该 agent 的新指令，agent 在原 worktree 继续迭代。注意：**diff review 只适用于程序员用户**；Neo 的 cowork 非程序员用户看不懂 diff，等价原语是**在 artifact 预览里圈选元素定点反馈**——PPT 某一页 / 表格某单元格 / 网页某区块 → "这里不对，改成 X" → 直接变成 agent 迭代指令。交互原语相同（局部锚定反馈，替代整段 follow-up），载体从代码 diff 换成渲染后的产物。Neo 已有 artifact 预览面板（Deck/Spreadsheet/Dashboard），缺的是"圈选 → 反馈 → 定向迭代"这条链路

### P1-3 多 agent 协作过程可见性（借鉴 Cumora Whisper rooms + Deux Manager 状态流）

**为什么是 P1**：cowork 用户（非程序员协作者）需要看到"agent 们在怎么讨论"才会信任产出。Neo 的 SwarmMonitor 只有任务进度条，过程是黑盒。

**怎么做**：
- SwarmMonitor 加"讨论流"视图：把 agent 间的 SharedContext 读写、result passing 渲染成对话流
- 给 subagent **命名角色感**（Deux 用物理学家名字 Popper/Dirac/Ptolemy）+ 人话状态流（"Planning completed. No product code modified."）——状态文案对非程序员可读，比 "task_id: xxx running" 强一个量级
- 关键决策点（agent 分歧、方案选择）高亮，用户可介入
- 这是 UI 层工作，后端 L0-L2 通信模型已有数据

### P1-4 多 agent 交互层 AX 原语（借鉴 Slock，做路线②能力的预埋）

**为什么是 P1**：Slock 指出的问题是真实且通用的——agent 是回合制的，多 agent 共享上下文时，每个 agent 都在对"已过期的状态快照"行动，这是所有多 agent 混乱（重复回复、抢任务、答非所问）的根源。Neo 的 parallelAgentCoordinator 现在靠 DAG 依赖把 agent 隔开，回避了这个问题；但一旦做项目空间（P0-2）+ 主动性（P0-1），多个 agent 就会真正"共处一室"，这个问题必然爆发。

**两个可直接落地的原语**：
1. **Agent Inbox（pull 模型）**：SharedContext 的变更不推给 agent（污染上下文），变成可查询的 inbox item，agent 在自己的轮次里决定 pull 什么
2. **Draft 新鲜度检查**：agent 产出的结论/动作带"基于哪个版本的 SharedContext"标记，提交时状态已变 → 退回并附变更摘要，agent 决定重写/照发/放弃

**判断**：这两个原语的工程量不大（SharedContext 已是 KV，加版本号即可），但能让 Neo 的多 agent 协作质量上一个台阶，并且是竞品里唯一一家（Slock）想清楚了的东西——先做就是先发优势。

### P2-1 Persona 产品化（借鉴 codeg experts.toml + Cumora starter agents + Slock 持久身份）

- Neo 已有 custom agent（markdown frontmatter）→ 缺的是产品化：预设 4-6 个角色（研究员/设计师/数据分析师/PM），带头像、人格、可在 UI 一键"招入"项目
- codeg 的 experts.toml 形态可直接参考：分类 + 多语言 + 图标 + sort_order
- 结合 P0-1 的持久身份：persona 不只是 prompt 模板，而是有自己记忆、跨项目存活的"同事"（Slock 模式）

### P2-2 垂直技能包（借鉴 Coze 3.0）

- 9 个 builtin skill → 按场景打包成"技能包"：调研分析包、内容创作包、数据分析包
- 对标 Coze 的行业专家包，但走本地化差异：技能包可以调用本地文件/Photos/桌面能力

### P3 战略决策：被编排 vs 自己做编排层

Coze 3.0 想收编本地 agent。Neo 有两条路：

| 路线 | 含义 | 判断 |
|------|------|------|
| **A. 开放被编排** | 实现 ACP / 暴露 MCP server，让 Coze/codeg 能把 Neo 当成员接入 | 获得分发渠道，但沦为 worker，品牌被淹没 |
| **B. 自己做编排层** | 强化 agentEngine（已支持 Codex CLI / Claude Code），Neo 当指挥家 | 和 Neo 的 cowork 定位一致，且执行深度+本地化是差异化 |

**推荐 B 为主、A 为辅**：Neo 的核心资产是执行深度和本地隐私，应该做"本地 AI 团队的家"，而不是别人云平台里的一个工人。但可以低成本暴露一个只读 MCP server（任务状态查询），蹭 Coze 生态的曝光不丢主权。

---

## 五、不建议做的（明确排除）

1. **不要追 Coze 的生态规模**（200+ 插件、全端、云电脑）—— 字节的资源体量打不过，Neo 的胜负手在单机深度。
2. **不要做多人协作（真人邀请）**—— Cumora/Coze 都在做，但这需要云端账号体系+同步基建，与 Neo 本地优先架构冲突，投入产出比极低。
3. **不要复刻 Coze Loop** —— Neo 的评测中心（Swiss Cheese + 归因 + replay）概念覆盖已超过它，把进行中的 Fleet Observability 收尾即可。

---

## 附：信息来源

- Agent Neo 现状：仓库 v0.16.89 全量盘点（docs/architecture、docs/decisions、src/main 各模块）
- Coze 3.0：IT之家、53AI、新浪财经、网易（2026-06-01 发布报道）、coze-loop/coze-studio GitHub
- codeg：github.com/xintaofei/codeg 源码（acp/、delegation/、chat_channel/、experts/）
- Cumora：cumora.ai 官网、updates.cumora.ai、moge.ai 产品目录
- Slock.ai：slock.ai 官网 + 两篇官方博客（introducing-slock / is-having-agents-in-the-room-meant-to-be-chaotic）、codepick.dev 第三方指南、创始人 X（@istdrc / @zty0826）
- Deux：harness.today 官网、作者 X（@hwwaanng，11 产品发布推文）、GitHub eyhn
