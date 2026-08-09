# 会话指挥台与工作台交互合同（post-v0.30）

本文是 post-v0.30 已交付能力的**用户可见交互合同**：状态如何表达、入口在哪里、确认与信任文案长什么样。架构实现细节不重复，统一引用事实源。

## 事实源与验收口径

事实源（as-built，冲突时以它们为准）：

- `docs/plans/2026-08-07-neo-post-v0.30-as-built-spec.md`（下称 SPEC）
- `docs/ARCHITECTURE.md`、`docs/architecture/agent-core.md`、`docs/architecture/workbench.md`、`docs/architecture/surface-execution.md`、`docs/architecture/data-storage.md`

验收口径分层，写作与汇报时必须区分：

- **自动化门已绿**：本文描述的交互均有自动化测试锚点（见 SPEC §5 清单）。
- **未完成发布级验收**：ADR-054 指挥台交互仍需以下一发版 tag 的 fresh build、真实文字/语音会话、数据库/日志双信源重新验收；真实 UI cancel 长命令、真实长 run pause/resume 仍属手工 smoke 项。任何对外表述不得把"自动化绿"写成"真机体验已验收"。

每条合同按三层标注：**已实现**（代码与自动化在）、**边界**（当前明确不覆盖）、**欠账**（后续设计/工程债）。

---

## 1. 会话即指挥台

**核心隐喻**：会话不是一问一答的聊天窗，而是持续可输入的指挥面。后台有活儿时，对话不锁、输入框不灰。

### 已实现

- **前台持续可输入**：任务运行中用户可继续发消息、steer 或 stop。renderer 不再有"下一轮排队中"的第二套状态文案——新输入直接进入当前会话控制链，UI 只投影 `sessionTaskSlots` 与真实运行状态。（SPEC §2.1、workbench §3.0）
- **派活动词的用户侧表达是自然语言**：spawn / steer / cancel / status 不做成 slash 命令或固定按钮组，而是前台窄工具（`spawn_task / steer_task / cancel_task / task_status`）由对话触发。文字与实时语音共享同一合同。（SPEC §1、§2.1）
- **幂等**：重复派活由 `submissionKey` 收敛到既有任务，用户不会因为连点/复述而开出两件一样的活。（SPEC §2.1）
- **并发上限的用户投影**：全局最多 4 件、单会话最多 2 件、同一 lane 同时 1 件。活跃时 `ChatView` 顶部出现 Run Status Rail（`TaskStatusBar`），聚合 running/queued、活跃 session 与进度；无后台、无队列、无团队时不出现。点击跳转到对应 session 或打开 TaskPanel / Agent Team。（SPEC §2.1、§3；workbench §4.0.1）
- **容量满 = 用户选择，不是系统独断**：容量已满且调用方未明确允许排队时返回 `requires_choice`，由前台把选择摆给用户（排队还是顶替/取消别的），不静默扩容、不静默拒绝。（SPEC §2.1、workbench §3.0.1）
- **歧义 = fail-closed 回到用户**：`task_status` 序号只指当前活跃任务；目标缺失、已终态或指代歧义时，不猜测、不回落操作另一件任务，必须回到前台向用户澄清。后台自动化轮次（`/loop`）禁止 `AskUserQuestion`——只有前台能向用户提问。（SPEC §2.1、agent-core §2026-06-05）
- **终态双通道**：任务终态既写回会话 system message（供后续指代与诊断），也投影到后台账本（Run Status / Task Workspace / 通知）。`cancelled` 就是 cancelled，不包装成 complete。（SPEC §2.1、agent-core）

### 边界

- `SessionTaskSlotLedger` 是进程内控制面：终态与用户可见回流落库，但排中队列本身不是跨重启调度日志，重启后排队状态不恢复（恢复走 TaskManager / Durable Run 既有合同）。（SPEC §4）

### 欠账

- 真实文字/语音会话的发布级 fresh-build 验收未做（见验收口径）。
- 语音侧"随时开口快捷键引导、成本与单通上限"的交互细节在 `docs/architecture/live-voice.md`，本文不覆盖。

---

## 2. 单 spawn 转后台

**核心隐喻**：一个前台放不下的单 agent 任务转后台后，用户在界面上看到的仍是一个"真实成员"，不是幽灵进程。

### 已实现

- **成员条 / Overview / 停止入口全部显示真实状态**：单 `spawn_agent` 超时转后台时，`singleSpawnVisibilityRegistry` 建立短生命周期 UI scope 映射，复用 swarm 投影——`SessionMemberBar` 成员条、Task Workspace Overview、run-level stop 三处看到的都是真实后台状态，不是副本。（SPEC §2.2、workbench §3.0.1）
- **停止入口**：成员条上的 run-level stop；取消经 registry 路由回原 agentId。synthetic UI scope 只是显示身份，不是执行身份。（SPEC §2.2）
- **终态立即可见 + 映射即时清理**：完成 / 失败 / 取消后映射立即删除，成员条不残留"已死的成员"；终态同时走 §1 的双通道（会话消息 + 账本 + 系统通知）。（SPEC §2.2、agent-core）

### 边界

- synthetic scope 不参与并发配额、恢复或执行身份判断——它纯粹是可见性装置。（agent-core §2026-08-04~07）

---

## 3. Composer 上下文分槽

**核心隐喻**：composer 记住的每样东西都有明确归属——这条草稿、这个空间、这个会话——切换时不悄悄带走。

### 已实现

- **三槽隔离**：`ComposerScopeKey` 区分 `draft`、`space:<projectId>`、`session:<sessionId>`。工作目录、routing、browser mode、skills/connectors/MCP、团队配方、pin、专家意图逐槽独立保存；切换会话或空间只切 active scope，**不复制上一槽状态**。（SPEC §2.3、workbench §3.0.2）
- **用户可见投影**：inline chips / team / pin——上下文归属以 chip 形式就近呈现在 composer，而不是藏进全局设置。（SPEC §3）
- **移交而非复制**：从草稿或空间发起新会话时，`planScopeHandoffToSession()` 把当轮选择移交到新会话槽：pin 经 `setSessionPin` 物化、专家经 session binding 物化，**源槽随后清空**。Library 的"带进新会话"走同一条路径，不再先建空会话再异步补 pin。（SPEC §2.3、workbench §3.0.2）
- **真源规则**：已物化的 session pin 以 host 为真源；renderer 的 pending pin 只表示"尚未创建 session 的挂载意图"。注入时过滤已不存在的条目。（SPEC §2.3、data-storage `session_context_pins`）

### 设计欠账

- 附件（attachment）的槽归属在事实源中没有独立条款，目前只由"分槽不串扰 + 随消息发送"隐含覆盖；若后续要表达"附件属于哪一槽"，需要补一节视觉规则。

---

## 4. Browser 工作台：信任与接管

**核心隐喻**：浏览器是共享驾驶位。Agent 开车时用户伸手，先打招呼再碰方向盘；账号态是用户的私产，迁移必须本人发起。

### 已实现

- **地址栏是用户的一等入口**：地址栏回车导航、后退/前进/刷新、URL/标题/favicon 回写、加载中与失败状态，全部读 managed browser session state——Browser tab 不是只读留影面。（SPEC §2.4、surface-execution §Browser Phase 2/3）
- **同页操作的确认/接管**：Agent 正在执行时，用户导航或点击先经过 `browserStageInteractionGate`，不静默抢写同一页面；live frame 的点击/输入/按键/滚动经 `UserBrowserLinkService` 进入 owner-aware 队列。用户可见状态机：`Takeover: requested → human_control → resume_pending → running（或 cancelled | timed_out | navigated）`；接管期间释放 provider 输入，由 InterventionCards（Takeover+Recovery）表达。（SPEC §2.4、surface-execution §状态机/§分层总览）
- **stop 是硬边界**：stop 之后旧 mutation 不得继续改页面，迟到的截图、引用与结果不得覆盖新一轮执行。（surface-execution §状态机）
- **固定转人工**：登录、MFA、CAPTCHA、支付、账号安全动作不做自动化，固定走 manual takeover / unsupported 分流。Permission Card 必须呈现目标、能力档、数据去向、有效期与拒绝影响；默认"允许一次 / 本次任务 / 拒绝"，高风险能力不提供无边界 Always。（SPEC §2.4、surface-execution §安全与脱敏）
- **persistent profile 的信任表达**：Managed Browser 默认使用 Neo 管理的个人 persistent profile——**不等于接管用户当前 Chrome 进程**。（SPEC §2.4、§4）
- **Cookie 导入的信任表达**：必须由用户从 overflow menu 显式发起 + host approval；导入用临时副本读 cookie DB，UI/日志只呈现**数量与截断后的域名摘要**，永不暴露 cookie value。（SPEC §2.4、surface-execution、workbench §4.4）
- **Relay 的信任表达**：tab 附着走 `lease.request → 用户批准 → lease.return`；只接管用户显式附着的标签，debugger 横幅保持可见，不自动碰未附着标签。（surface-execution §Relay v2、workbench §4.4）

### 边界

- Cookie 导入只解决"显式选择的账号态迁移"，不等于完整浏览器环境克隆。（SPEC §4）

### 欠账

- Relay 签名分发与升级兼容的运行时证明仍在补强；remote browser pool、Firefox/Safari profile 导入、完整 localStorage/IDB 镜像在 backlog。（SPEC §4、workbench §1 流 E）
- 真实外部网站、真实账号、反 bot/CAPTCHA 不纳入自动 smoke。（workbench §4.4 Acceptance）

---

## 5. 会话历史、导出与诊断

**核心隐喻**：历史是可达的、导出是有分级的——能搜到、能翻页、能带走，但"能带走"分两级，风险文案不藏。

### 已实现

- **搜索**：会话搜索接 `session_messages_fts`。3 字及以上走 FTS5；中文 2 字短查询在 UI 路径显式回落 LIKE。默认过滤 rewound、meta、loop 内部消息；显式 `includeRewound` 才查完整历史。（SPEC §2.5、data-storage）
- **分页**：侧栏列表 SQL `limit/offset` 分页；active / archived / all 三种过滤在 host 查询层成立；静默刷新保持已加载窗口，追加页按 id 去重——历史会话不再"翻不到"。（SPEC §2.5、data-storage）
- **持久化健康提示**：Web 端 SQLite 不可用时，只在 `durable=false` 时提示"历史未持久化"——健康时不打扰。（data-storage §2026-05-22）
- **导出入口**：UI 右键导出与 CLI（`neo session list/timeline/export/digest`，readonly SQLite handle，不启动 Agent、不改 DB）复用同一 package builder。诊断包 v2 同包含 transcript、五泳道 ledger、日志时间窗、audit、permission decisions、tool executions、环境指纹、manifest；telemetry 缺失时 transcript/ledger 仍可导出。（SPEC §2.5、data-storage）
- **两级导出的风险表达**：
  - `shareable`：规则化脱敏 home path 与 credential-like 内容——但文案必须保留"**对外发送前人工复核**"，不把脱敏说成免责。
  - `full-local`：可能含 prompt、命令、路径与敏感信息——**只允许本机排障，不得默认分享**。（SPEC §2.5、§4；data-storage）

### 边界

- FTS/分页解决"历史内容够不到"，不改变云同步完整性，也不保证已本地删除或从未同步的会话可恢复。
- 诊断包证明"当时落盘了什么"，不证明线上 provider、外部 CLI 或浏览器当前仍可用。（SPEC §4）

---

## 6. User Directives 与 User Memory

**核心隐喻**：directive 是用户亲手签的规则，memory 是 agent 自己记的笔记——两者在视觉上必须一眼可辨，在权限上天差地别。

### 已实现

- **分块注入、视觉可辨**：`User Directives` 与 `User Memory` 分块注入、分别写入 `memoryInjectionTrace`，审计层面两块永远可区分。（SPEC §2.6、workbench §3.0）
- **语义差**：directive 只接受用户经 `MemoryConfirmModal` 明确确认的规则，优先于产品默认偏好，但仍受 system/developer、安全、权限与工具策略约束，**不能授权外部或破坏性动作**；memory 只是可错的个性化上下文，不提供指令或授权。（workbench §3.0、agent-core）
- **写入 directive 路径必经确认（防绕过）**：`directiveMemoryPathAuthority` 在 `ToolExecutor` 统一识别写记忆目录的 Write、Bash 重定向、MemoryWrite 及声明式 path 参数；缺少与本次 tool+params+targets 精确匹配的确认 fingerprint 就拒绝执行。任何写入路径——不止 MemoryWrite 工具——都被同一道门拦住。（SPEC §2.6、agent-core）
- **落盘诚实**：规则文件同目录临时文件 + 校验 + fsync + rename；坏文件进 `.corrupt-*`，不混进活动记忆集合。规则可在记忆管理删除，frontmatter 保留确认请求 ID 与时间。（SPEC §2.6、workbench §3.0）

### 边界

- directive 优先级是"优先于产品默认偏好"，不是"高于系统与安全约束"——确认弹窗与记忆管理文案不得暗示前者可以覆盖后者。

---

## 写作守则（本文自身的维护规则）

- 本文只写**用户可见**的交互合同与状态表达；实现机制改动请更新架构文档后回链，不在此展开。
- 新交互进入本文前必须已在事实源中标为已实现，并带来自动化锚点；"计划中"一律进欠账区，不写成已实现。
- 验收口径一节随每次发布级验收更新，未做 fresh-build 验收前不得删除该声明。
