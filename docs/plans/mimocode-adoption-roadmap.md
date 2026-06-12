# MiMoCode 借鉴落地路线图（五阶段）

> 日期：2026-06-11
> 来源：docs/competitive/ 下四份 MiMoCode 对比报告的提炼
> 原则：先快赢抬分 → 再补基建 → 基建上长出学习闭环 → 体验对标 → 架构演进选做
> 工程量标记：S（≤1 天）/ M（2-5 天）/ L（1-2 周+）

## 阶段总览

| 阶段 | 主题 | 核心产出 | 依赖 |
|------|------|----------|------|
| 一 | 快赢与防呆 | 评测分提升 + 主循环稳定性 | 无，全是独立改动 |
| 二 | 基建补课 | FTS5 历史索引 + 命令协议层 + 方法论 skill | 无，但为阶段三铺路 |
| 三 | 学习闭环 + 跨 session 续作 | dream / distill / Max Mode / checkpoint 重建 | 依赖阶段二 |
| 四 | 体验对标 | 渲染、审批、回退、语音四类交互升级 | 无硬依赖，可与三并行 |
| 五 | 架构演进（选做） | snapshot/缓存/扩展性长期项 | 单独评估 |

---

## 阶段一：快赢与防呆（全部独立改动，可并行）

目标：不动架构，直接提升 edit 成功率、防止模型跑飞、堵住停止判定漏洞。这一阶段全部做完，SWE-bench 类评测分应有可测量提升。

| # | 事项 | 量级 | 来源 | 要点 |
|---|------|------|------|------|
| 1.1 | **Edit 多级 replacer 链** | M | 报告③ | 先移植 3 级：LineTrimmed（行 trim）、BlockAnchor（首尾锚点+Levenshtein 0.3）、IndentationFlexible（缩进容错）。纯函数可单测。⚠️ 直接移植代码须在文件头加 `// Adapted from MiMoCode (MIT)` |
| 1.2 | **doom loop 三层防护** | S-M | 报告② | L1 同名同参工具调用 ×3 → 人工确认；L2 行动签名（stableStringify 排序 key）重复 ×3 → 注入 nudge；L3 空输出/截断自动续接带上限。计数器每轮用户输入重置。**已落地（2026-06-11）**，适配备注：Neo 主循环无人工审批通道，L1 的"人工确认"以"强警告→再犯中止 run 交还用户"作为架构等价物（doomLoopGuard.ts） |
| 1.3 | **taskGate** | S-M | 报告③ | TaskManager 数据现成：stop 前查 pending/in_progress 任务，注入"task done/cancel"重入消息，main 上限 3 次、subagent 上限 2 次。**已落地（2026-06-11，nudgeManager P2 升级）**，适配备注：subagent 上限 2 依赖 owner 语义，Neo 主循环暂无 subagent 身份标识，与 2.6（task 树 + owner）一并落地 |
| 1.4 | **goal judge 提示词加固** | S | 报告④ | 三件套：verdict 必须引用 transcript 原文做证据；"模型自称 impossible 是证据不是证明"；无证据默认 fail。顺手加 `impossible` verdict（目标不可达主动止损） |
| 1.5 | **截断的错误感知** | S | 报告③ | 截断前扫输出尾部 2048 字符找 error/exception/traceback/panic，命中则头 70%/尾 30% 分配预算保住报错 |
| 1.6 | **max-steps 兜底提示** | S | 报告④ | 步数耗尽 → 禁用工具、强制纯文本三段总结（已完成/未完成/建议下一步） |
| 1.7 | **CLI 非交互安全默认** | S | 报告② | run/batch 模式默认 deny question 类权限防 CI 挂起，`--dangerously-skip-permissions` 显式逃生门 |
| 1.8 | **主提示词加"完成三要素"** | S | 报告④ | 非 goal 模式日常任务也要求：代码改动 + RUN 过验证 + 最小化；禁止 should/probably/seems to 措辞声明完成 |
| 1.9 | **retry 策略加固** | S | 报告② | 错误分类收敛到单一来源（429/5xx/网络可重试，4xx/context overflow 不重试）；优先尊重 `retry-after` 响应头再退指数退避 |
| 1.10 | **instructions 稀疏回退** | S | 报告③ | 项目 AGENTS.md < 500 字符时自动补充加载 CLAUDE.md，迁移期兼容 |

验收：eval 集跑前后对照（重点看 edit 失败重试率、无效循环轮数、假完成率）。

## 阶段二：基建补课（为学习闭环铺路）

目标：补上三块协议级基建。它们各自独立有价值，同时是阶段三的前置依赖。

| # | 事项 | 量级 | 来源 | 要点 |
|---|------|------|------|------|
| 2.1 | **会话转录 FTS5 索引 + history 工具** | M | 报告③ | SQLite FTS5 表索引全部转录（按 kind：tool_input/output/user_text/assistant_text/reasoning 分类），暴露 search + around 两个 action 给模型。**dream/distill 的"轨迹库为权威来源"踩在这上面**。**已落地（2026-06-11，已验收）**，适配备注：与既有 session_messages_fts（episodic recall）并存——transcript_fts 覆盖 tool/reasoning 全 kind；落地时发现 Neo deferred-loading 下"registry 注册 ≠ 模型可见"，History 须同时登记 DEFERRED_TOOLS_META（EpisodicRecall 同类缺口仍在，待单独评估） |
| 2.2 | **/命令协议层** | M | 报告③ | 注册表 + frontmatter（description/agent/model/subtask）+ $ARGUMENTS/$1 模板 + `.code-agent/commands/<name>.md` 文件式自定义 + MCP prompts 自动入表。**distill 自进化产出物的天然载体**。**已落地（2026-06-11）**，适配备注：frontmatter 的 `agent` 经 `options.agentOverrideId` 接 orchestrator 显式路由；`model`/`subtask` 仅解析保留——Neo 暂无消息级模型覆盖与"命令即子任务"通道（MiMo 的 model_groups/subtask 不同构），待有真实需求再接 |
| 2.3 | **superpowers 收编为内置方法论 skill** | S-M | 报告④ | MiMoCode 已验证此路：把 superpowers（MIT）的 brainstorm/tdd/debug/verify/review/merge 等打包进 Neo 内置 skill 集，补齐"流程方法论层"（Neo 现有 builtin 偏任务型）。保留铁律原文风格。**已落地（2026-06-11）**，适配备注：review 更名 work-review（避撞既有任务型 review）；归入 development 分类 |
| 2.4 | **prompt 按 provider 家族分变体** | M | 报告④ | 至少 2 套：Claude 系（详尽工具规范+Git 安全）、GPT/国产系（强化自治防过早停）。从现有主提示词分叉，A/B 跑 eval 验证。**已落地（2026-06-11；2026-06-12 audit D 返工补 A/B 基建）**，适配备注：① 不 fork 整份主提示词，base + 家族 addendum（控 eval 回退面，default 家族零改动）；**覆盖面与 MiMo 有差距**——2 套 addendum（claude/autonomous）vs MiMo 12 套整 fork，gemini/beast 等家族缺位，default 家族无变体；② A/B 机制走 `CODE_AGENT_DISABLE_PROVIDER_VARIANT=1` 关变体（`run_eval.sh --variant-off`），臂别记录在 run metadata（`environment.providerVariantArm`）与 trend point，**不按 promptVersion 对比**（D-Y1：diagnosticVersions 不感知该 flag，两臂同版无法区分；当时误 bump 的 sys-v6 已回退 sys-v5）；③ 自带 prompt（项目 SYSTEM.md / agent 路由自带 / FULL_SYSTEM.md）统一不注变体（D-Y2）；④ A/B 对照已实跑（2026-06-12，prompt-real-smoke 8 case × 两臂，MiMo mimo-v2.5-pro，替代 SWE-bench harness）：variant-on pass 75.0% / avg **83.9%**，variant-off pass 75.0% / avg **75.0%**——验收门"eval 分不回退"通过；差值全部来自 git-status-no-commit（on 臂 partial 0.714 vs off 臂 90s 超时 0 分），n=8 且两臂各有 1-2 次 Token Plan 429 噪音，只下"无回退"结论不下"提升"结论。报告：test-results/report-20260612T004127（on）/ report-20260612T004647（off）。MiMo 实跑须节流（`XIAOMI_MAX_CONCURRENT=2` + `XIAOMI_MIN_INTERVAL_MS=1500`，否则 ~1 分钟即 429 风暴） |
| 2.5 | **memory 检索补 BM25 通道** | S-M | 报告① | embedding（pgvector）之外加 SQLite FTS5/BM25 零成本检索通道，与 2.1 共用基建；本地优先场景降外部依赖，可做混合检索。**已落地（2026-06-11）**，适配备注：侦察发现本地链路并无 embedding 检索（原为 LIKE 全扫 + 应用层 token 评分），BM25 实为召回质量升级而非"第二通道"；packMemoryEntries 的混合召回用它突破"最近 500 条"窗口 |
| 2.6 | **task 树状结构 + owner 语义** | M | 报告③ | 树状 ID（T1 → T1.1）、owner=subagent 所有权、orphan 任务由主会话接管、完整事件日志（created/blocked/done…）可审计——与 1.3 taskGate 配套成完整任务语义层。**已落地（2026-06-11）**，适配备注：保留 Neo 数字 id（"1"→"1.1"，不引入 T 前缀避免破坏既有数据/UI）；subagent taskGate 上限 2 落在 subagentExecutor 收口点（1.3 挂的尾巴已补） |

验收：2.1/2.2 有模型可调用的工具/命令；2.3 skill 列表可见可触发；2.4 eval 分不回退。

## 阶段三：学习闭环（Neo 三大空白，依赖阶段二）

目标：补齐 dream / distill / Max Mode——对比中 MiMoCode 赢得最干净的三项。建议按 dream → distill → Max Mode 顺序（前两个纯 prompt 驱动成本低，Max Mode 工程量最大）。

| # | 事项 | 量级 | 依赖 | 要点 |
|---|------|------|------|------|
| 3.1 | **dream（session 复盘→记忆）** | M | 2.1 | 照 dream.txt 五阶段：定位数据→读现有记忆→从摘要提候选→**SQLite 查原始轨迹验证（防幻觉）**→写入记忆并清理过期。每 7 天自动 + 手动触发。原则：轨迹库为权威，memory 是缓存。直接回应 ADR-020 |
| 3.2 | **distill（重复工作流→skill/command）** | M | 2.1 + 2.2 | 照 distill.txt 六阶段：盘点现有资产→扫记忆找重复信号→SQLite 频率验证（≥2 次门槛）→打分→按最小形式产出（skill/command/subagent）→自动注册。Neo 的后半段（skill_create、热加载、usage 衰减）全是现成的。每 30 天自动 |
| 3.3 | **Max Mode（best-of-N）** | L | 1.4（judge 提示词复用） | 三段式：toSchemaOnlyTools 剥离 execute 做 propose-only 并发（N=5）→ judge 选索引（fail-open 选 0）→ 赢家 replay 执行。失败候选成本计 overhead 不进上下文估算；全失败降级单次调用。Neo 的 scriptRuntime 已有 forced tool_choice 和并发基建 |
| 3.4 | **checkpoint-writer + 跨 session 重建** | L | 2.1 | 后台子代理周期写 11 段结构化 checkpoint（§1 用户意图逐字引述 + COMMITMENT/INSPECTION 动词分类决定是否更新 + 精确值 byte-for-byte 保留 + 路径纪律）；上下文逼近上限时优先插入重建边界（checkpoint + 记忆 + 尾部消息按 token 配额重建）而非纯压缩。**把 Neo 的"压缩派"升级为"压缩+重建"双轨，补齐跨 session 续作能力**——这是报告①指出的 Neo 压缩路线覆盖不到的场景 |

验收：3.1/3.2 跑一个月后检查记忆质量和自动产出的 skill 是否真被复用；3.3 在 eval 集上对比开关 Max Mode 的分数差与成本比；3.4 验证中断后新 session 能从 checkpoint 续作。

## 阶段四：体验对标（可与阶段三并行，桌面产品差异化）

| # | 事项 | 量级 | 来源 | 要点 |
|---|------|------|------|------|
| 4.1 | **未闭合代码块流式分块** | S | 报告② | markdown 流式渲染时检测 unclosed code block 拆两块分别渲染，长代码不再"看起来卡住"。渲染层独立改动 |
| 4.2 | **权限审批 diff 视图** | M | 报告② | 审批卡直接展示 filepath + diff（宽屏 split / 窄屏 unified 自适应）。Neo 的 GuardFabric 决策链已有数据，升级呈现层 |
| 4.3 | **Timeline + Revert + Fork** | M | 报告② | 时间线列出用户消息（倒序单行化），每条可 Revert（连文件改动恢复、原文回填输入框）/ Fork（分支新会话）。Neo 的 rewind/fork 后端现成，补交互层 |
| 4.4 | **bash-interactive 用户接管** | M | 报告③ | 命令需密码/确认时终端移交用户、等待不计超时，事件对驱动 UI。Neo 现有 PTY 只能等最终输出 |
| 4.5 | **sidebar slot 插件化（选做）** | L | 报告② | slot + order 注册机制让侧栏面板解耦。重构性质，优先级最低 |
| 4.6 | **语音输入管线** | M-L | 报告①④ | 三段：VAD 实时断句（如 silero-vad）→ ASR 可插拔（本地 whisper.cpp / 云端 ASR，**不绑特定模型**，MiMo 绑自家 ASR 是它的商业选择不是技术必然）→ LLM 语音指令解析为严格 JSON 结构化动作（编辑输入框/发送/切 agent，含填充词过滤和自动纠正）。桌面端（Tauri 有麦克风权限）差异化亮点，也是作品集的演示性功能 |
| 4.7 | **delta 级落盘 + patch tracking** | M | 报告② | text/reasoning delta 实时落盘（中断时部分结果可见可恢复）；每 step 前后文件快照 diff 生成 patch 记录，驱动文件修改可视化与消息级 revert（与 4.3 配套） |
| 4.8 | **token/cost 透明展示** | S | 报告② | subagent footer 式：当前消息 token 占 context limit 百分比 + 美元成本实时展示 |
| 4.9 | **错误页预填 issue URL** | S | 报告② | 崩溃/错误页一键复制含版本+堆栈的 GitHub issue 链接，降低反馈摩擦 |

## 阶段五：架构演进（单独评估，不进默认排期）

| # | 事项 | 量级 | 决策点 |
|---|------|------|--------|
| 5.1 | snapshot 迁移隔离 gitdir | M | 解除 SQLite 快照 1MB/50 个上限，diff 免费。`--git-dir` 放数据目录零污染用户 git。低风险可提前 |
| 5.2 | prefix cache 字节对等 + ForkContext 冻结 | M-L | subagent spawn 复用 parent 前缀冻结快照，缓存命中变确定性。需审计 Neo 现有上下文构建路径 |
| 5.3 | shell invocation 模式 | M | per-tool shell 语法 + recover 降级，针对 JSON 弱的国产 provider。等 1.x/3.x 落地后看 provider 错误率数据再决定 |
| 5.4 | 对外 plugin SDK | L | hook 点（chat/tool/permission）+ 工具/组件注册。看 Neo 是否有生态诉求，求职作品集角度未必需要 |
| 5.5 | server-centric 架构评估 | 思考题 | 业务逻辑下沉独立 server、三端薄客户端。一次性大迁移，只建议写一页 ADR 评估，不动手 |
| 5.6 | 零配置首跑 + predict_next_prompt | M | 产品层：免注册免配置的首跑体验（参考客户端指纹换临时额度的获客思路，Neo 可接低价国产模型做免费通道）；小模型预测用户下一条输入做输入框 hint |
| 5.7 | 会话 share 链接 | M | snapshot + 事件日志增量同步、带 secret 的分享链接。作品集演示场景有用（直接把一次 agent 会话发给面试官看） |

---

## 给求职叙事的提示（顺带产出，不占排期）

- 阶段一完成后即可讲："对标小米开源 MiMoCode 做了竞品代码级分析，识别 X 项差距，落地后评测分从 A → B"——完整的竞品分析→优先级→落地→量化验证闭环，是 AI PM 面试的现成案例
- 经核实的差异化论据：MiMoCode 385 个单测但 CI 只跑 typecheck、零 eval 体系；Neo 的评测驱动闭环在开源对手（含小米）中是稀缺能力
- 哲学对比一句话：MiMoCode 信模型（judge/prompt/重建），Neo 信代码（确定性压缩/代码验证/引擎编排）
