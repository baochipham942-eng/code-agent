# MiMoCode 收官篇：Prompt 资产 / 内置 Skill 与插件 / 产品战略 / 许可证 / 质量工程

> 日期：2026-06-11
> 系列第四篇（完结）：①六项核心能力 `mimocode-vs-neo.md` ②UX/CLI/runtime `mimocode-design-learnings.md` ③工具/命令/task `mimocode-tools-commands-task.md`

## TL;DR

- **Prompt 资产**：按模型分变体（anthropic/gpt/beast/default 四套主提示词）是最大启示；checkpoint-writer 的 11 段模板和 goal judge 的防欺骗措辞可直接抄
- **内置 skill 真相**：compose 的 15 个内置 skill 基本是社区 **superpowers 技能包的收编**（description 逐字一致）——方法论层可以"拿来主义"，不必自研
- **产品战略**：免费 mimo-auto（客户端指纹零注册）获客 → Voice 锁登录做转化 → 语音+行为数据飞轮；商业化是 Stripe PAYG 不是订阅
- **许可证**：MIT + 行为限制清单（非代码复用限制）。**Neo 可以借鉴设计；直接移植代码片段（如 replacer 链）需在文件头保留 MIT 声明**
- **质量工程**：385 个单测文件但 CI 只跑 typecheck，**没有 eval 体系**——Neo 的评测驱动是坐实的差异化优势

---

## 一、Prompt 资产层

### 1.1 按模型分变体的主系统提示词（最大启示）

| 文件 | 行数 | 针对 | 关键差异 |
|------|------|------|----------|
| session/prompt/anthropic.txt | 154 | Claude | 详尽的工具使用规范 + Git 安全（禁 amend/禁 git config/精准 staging） |
| session/prompt/gpt.txt | 107 | GPT | 显式强化"自治和坚持"（默认假设要写代码、单轮做完）+ commentary/final 双通道 |
| session/prompt/beast.txt | 155 | 深度解题 | "不完全解决不许停" + 强制 web 研究补知识过时 + "测试不足是头号失败模式" |
| session/prompt/default.txt | 151 | 通用 | 激进简洁（非工具文本 ≤4 行，一词答案最佳）+ 禁注释禁过度工程 |

启示：不同模型的失败模式不同（GPT 易过早停、Claude 易话多），**一份通用 prompt 喂所有 provider 是次优解**。Neo 接 14+ provider，按 provider 家族分 2-3 套变体的 ROI 值得评估。

### 1.2 值得逐字借鉴的片段

**Git 安全**（anthropic.txt）：
> CRITICAL: Always create NEW commits rather than amending… When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, destroying prior work.

**专业客观性**：
> Prioritize technical accuracy and truthfulness over validating the user's beliefs… without any unnecessary superlatives, praise, or emotional validation.

**完成定义**（compose.txt）：
> You are NOT done until ALL of the following are true: 1. code changes 2. you have RUN verification and confirmed passing output 3. changes are minimal. DO NOT claim completion without a preceding verification tool call. "Should be fixed" without evidence is NOT completion.

**goal judge 防欺骗**（goal.ts 内嵌 JUDGE_SYSTEM）：
> the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment.
> 且要求 verdict 必须 quote transcript 原文做证据；无证据默认 `{"ok": false, "reason": "insufficient evidence in transcript"}`。

**max-steps 兜底提示**（max-steps.txt）：步数耗尽时禁用所有工具、强制纯文本输出"已完成/未完成/建议下一步"三段总结——优雅降级的范本。

### 1.3 checkpoint-writer 的工程化细节（11 段模板之外的纪律）

- **§1 用户意图逐字引述** + COMMITMENT vs INSPECTION 动词分类：implement/fix/build/create 才更新 §1，find/show/explain/why 保持不动，"拿不准就 KEEP——过期的 §1 可恢复，写错的 §1 抹掉了用户意图"
- **EXACT-FORM CONSTRAINT LITERAL**：DSN、seed、路径、token 等精确值必须 byte-for-byte 保留，禁止改写（连反引号和标点都不能动）
- **PATH DISCIPLINE**：只允许引用 prompt 顶部路径表里的路径，会话历史里出现的路径可能是上个 session 的陈旧引用
- **任务 ID 纪律**：只能用 task 工具返回的 ID，禁止编造

### 1.4 Top 5 可直接抄进 Neo

1. 按 provider 家族分主提示词变体
2. goal judge 的"引用证据 + 不信自报 + 无证据默认 false"三件套（Neo 的 L2 review gate 提示词可对照升级）
3. checkpoint/压缩摘要的 COMMITMENT/INSPECTION 意图分类 + 精确值逐字保留（Neo 的 L4 AI 摘要可加这两条纪律）
4. "完成三要素 + 禁止 should/probably 措辞"写进主提示词（Neo 已有 goal 闸，但非 goal 模式的日常任务缺这层）
5. max-steps 兜底的三段式强制总结

---

## 二、开箱即用的 Skill 与插件

### 2.1 内置 compose skill：15 个（编译进二进制）

brainstorm / plan / execute / subagent / parallel / worktree / tdd / debug / review / feedback / verify / report / merge / ask / new-skill

覆盖 brainstorm→merge 完整开发生命周期，外加 ask（提问规范）和 new-skill（创建 skill 的元能力）。

**关键发现：这套 skill 是社区 superpowers 技能包的收编**——description 与 obra/superpowers 逐字一致（tdd "Use when implementing any feature or bugfix, before writing implementation code"、debug 四阶段、verify 的 Gate Function、brainstorm 的 HARD-GATE）。铁律风格（"NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" / "NO FIXES WITHOUT ROOT CAUSE" / "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"）全部原样保留，并加了一条 Autonomous override（无人审批时 HARD-GATE 自动放行）适配无人值守场景。

**对 Neo 的启示**：Neo 的 20+ builtin skill 偏任务型（commit/review/test），缺流程方法论层。直接打包 superpowers（MIT）进 Neo 内置 skill 集是零成本补齐——MiMoCode 已验证这条路。

### 2.2 内置 TUI feature-plugin：13 个

- sidebar（10）：goal / task / todo / mcp / lsp / files / cwd / context / instructions / footer + tps（token 速率）——全部走自家 plugin slot API，dogfooding
- home（3）：tips / tips-view / footer
- system：plugins 管理面板

### 2.3 对外 plugin SDK（@mimo-ai/plugin）

Hook 点：chat.message / chat.params / chat.headers、tool.definition / tool.execute.before|after（可拦截改写）、permission.ask、command.execute.before、experimental.chat.messages.transform / chat.system.transform / compaction.autocontinue。可注册工具、TUI 组件（tui.ts 12.7K）、MCP server、provider。另有 Zed 扩展 + VSCode SDK。

**对照 Neo**：Neo 的 hook 系统是面向用户配规则的（YAML），不是面向开发者的扩展 SDK；"内置方法论全家桶 + 对外 plugin SDK"两头都是 Neo 的空白。

---

## 三、产品战略：模型-产品垂直整合（A 为事实，B 为推断）

### 3.1 免费通道设计（plugin/mimo-free.ts）

**事实**：mimo-auto 免费模型零注册可用——客户端指纹（SHA256(hostname+platform+arch+CPU+username)）换临时 JWT（50 分钟自动续期），header 标记 `X-Mimo-Source: mimocode-cli-free`。规格：1M 上下文 / 128K 输出 / 成本 0。

**推断**：匿名指纹制把采纳摩擦降到零，STATS.md 显示月下载量两周内 6.6M→10.2M——免费模型是获客诱饵，服务端凭指纹做追踪和限流。

### 3.2 登录转化与数据飞轮

**事实**：Voice（TenVAD + mimo-v2.5-asr）是唯一锁 MiMo 登录的功能；其余功能第三方模型全可用。

**推断**：漏斗 = 免费文本通道引流 → Voice 驱动注册 → 中英文编程语音指令是高价值训练数据 → 模型变好 → 体验变好。Provider-aware 路由（model_groups 成员匹配当前 provider，MiMo 上下文优先选 MiMo 模型）同时保护自家流量。

### 3.3 商业化（console/core/billing.ts + subscription.ts）

**事实**：Stripe PAYG（非订阅）——余额 ≤$5 自动充值 $20（手续费 4.4%+$0.30）；三档计划 free（promoTokens+日请求限额）/ lite（滚动窗口限额）/ black（$20/$100/$200 三档高容量）；**按 workspace 计费**（Account 与 Workspace 分离，成员共享额度）。基建：SST + Cloudflare Workers + PlanetScale，全 serverless。Enterprise 包是云托管协作版（share 快照+事件日志），未见自部署 license 管理。

**PM 视角**：dev tools 选 PAYG 而非订阅、按 workspace 而非按席位计费、free tier 用 promo token 而非时间限制——这三个定价决策都值得写进行业分析素材。

---

## 四、许可证事实确认（影响 Neo 借鉴方式）

- **LICENSE = 标准 MIT**：允许商用/修改/再分发，要求保留版权声明
- **USE_RESTRICTIONS.md = 行为限制**（7 条：违法/侵权/伤害/军事/恶意网络活动/个人数据滥用/高风险操作无人监督），**约束的是使用行为，不是代码复用**

**结论**：
1. 借鉴架构/算法设计（best-of-N 三段式、replacer 链思路、taskGate 机制）：**无风险**
2. 直接移植代码片段（如 edit.ts 的 replacer 实现）：**可以，但须在文件头保留 MIT 声明**，如 `// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license)`
3. 禁止使用 MiMo/MiMoCode 商标、禁止声称与小米有关联

## 五、质量工程事实确认

- **385 个测试文件**（packages/opencode/test/ 300+，覆盖 provider/workflow/tool/permission/history/task/snapshot/server 全模块）——单测文化是真实的
- **没有 eval/benchmark 体系**：无 SWE-bench、无 harness、无模型评估框架
- **CI 只有一个 workflow**：typecheck.yml（仅 `bun typecheck`，无 lint/test/build/e2e）
- STATS.md 是纯下载量统计（增长叙事，非质量指标）

**结论**：MiMoCode 的质量模型 = 本地单测自律 + 社区反馈快修，**没有评测驱动闭环**。Neo 的"标准化 Eval Set + SWE-bench Docker harness + 30+ 轮评测迭代"是经核实的差异化优势——面试叙事可放心使用"开源对手（含小米）普遍缺 eval 基建"这个论据。

---

## 六、系列收官：全四篇的合并结论

**MiMoCode 相对 Neo 的真实优势**（按借鉴优先级）：
1. 学习闭环三件套：Max Mode（best-of-N）、dream、distill
2. Edit 9 级 replacer 链（直接抬评测分）
3. /命令协议层 + history 工具（FTS5）
4. taskGate + 树状任务 owner 语义
5. prompt 资产：按模型分变体、judge 防欺骗措辞、checkpoint 纪律
6. superpowers 收编模式（方法论拿来主义）
7. UX 三件：流式代码块分块、权限 diff 视图、Timeline/Revert/Fork

**Neo 经四轮核实的真实优势**：
1. 6 层上下文压缩（确定性工程 vs MiMo 依赖 LLM 的重建）
2. Goal 三层闸 + 跨 session 持久化（vs MiMo 单 judge 不持久化）
3. 命令式 workflow 引擎（确定性控制流 vs prompt 驱动的 compose）
4. **Eval 体系（对手为零，已核实）**
5. 执行控制层：任务队列/并发/两级取消、GuardFabric 多源权限、provider 健康监控
6. 桌面纵深：Computer Use、活动捕获、视觉能力

两个产品哲学的一句话总结：**MiMoCode 信模型（judge 把关、prompt 编排、重建上下文），Neo 信代码（确定性压缩、代码层验证、引擎编排）。MiMoCode 强在让 agent 越用越聪明，Neo 强在让 agent 不出错。**
