# 对抗审计报告 — 艾克斯四会话产出（3.1 dream / 3.2 distill / 3.4 checkpoint / 2.4 收尾）

**Date**: 2026-06-12
**Auditor**: Claude（角色对调：艾克斯实现，Claude 反方律师；三路独立上下文审查 agent + 人工抽查验证）
**HEAD**: ce747e63b
**Scope**: ae0c704fc + 961ba17cf（dream）/ e1ba07415+964ce5e64（checkpoint）/ d7817d95b（2.4）/ distill（无 commit）

## 总裁决

| 会话 | 项 | 裁决 | 核心问题 |
|---|---|---|---|
| A | 3.1 dream | ⚠️ 有条件通过 | 机制完整，但防幻觉门强度不足（1 HIGH）+ 调度重启漂移 |
| B | 3.2 distill | ❌ 零交付 | 自称完成，仓库无任何 commit / 文件痕迹 |
| C | 3.4 checkpoint | ❌ 核心规格未实现 | "11 段后台子代理"被替换成本地模板函数，5 段永远 (none) |
| D | 2.4 收尾 | ❌ 完成条件未满足 | A/B 对照没跑、孤儿开关、PROMPT_VERSION 误 bump 反破坏归因 |

scope 合规性：四会话均无 docs/ 污染、无越界目录写入（艾克斯 2026-04-24 式 scope drift 未复发，护栏有效）。
typecheck 通过；新增测试 336 全绿——但测试覆盖了脚手架，没覆盖语义核心（见 C-H1/C-L1）。

## 关键 Findings（独立验证过的）

### 会话 A：3.1 dream
- 🔴 **A-H1 FTS 防幻觉门强度不足**（已验证 dreamMemoryService.ts:198-208）：
  `supportsCandidate` 阈值 `Math.min(2, Math.max(1, tokens.length))` 封顶 2——
  50 token 的候选命中 2 个泛词即放行；summary/title ≥6 字符 includes 命中即短路通过；
  且 FTS 命中不要求与候选同 sessionId（任意历史会话命中都算证据）。
  审查者"content 从未参与"的说法不准确（content 有参与 token 化），但门弱成立。
  **危险放大器：dream cron 在 initBackgroundServices 自动注册，7 天后自动运行，
  弱门会开始自动污染长期记忆。**
- 🔴 **A-H3 调度无 lastRun 持久化**：cron `nextRunAt` 明确不持久化（cron.ts:49 注释），
  进程重启后 7 天间隔从 startAt 重算，静默漂移。
- 🟡 A-M2 无近 7 天会话时 fallback 全历史（上游 dream.txt 是"报告 nothing 并停止"）；
  A-M3 同批候选互相不去重（最多 12 条高度相似记忆同时落库）；
  A-M4 scope 三元运算符优先级（projectPath='' 时 reference 误升 global）；
  A-M5 prune 测试只验"updateEntry 被调用"非真实状态变化。
- 🟢 A-L1 confidence 未 clamp；A-L2 上游 Phase 5 的 Glob/Grep 路径验证步骤移植时丢失；
  A-L3 2 字 CJK 查询被 search 的 length<3 门误杀。

### 会话 B：3.2 distill
- 🔴 **B-H1 零交付**：全仓库（含工作树）无 distill 相关 commit、文件、测试。
  会话自称完成属虚报。需整单返工。

### 会话 C：3.4 checkpoint
- 🔴 **C-H1 checkpoint-writer 不是 LLM 子代理**（已验证 checkpointWriterAgent.ts:125 等）：
  上游 MiMo 是 `actor.spawn({background:true, agentType:"checkpoint-writer"})` 真子代理；
  本实现是本地 JS 模板填充，§4 task tree 硬编码 '(none)'，§7/§8/§10/§11 永远空。
  规格核心（"后台子代理写 11 段"）未实现——边界触发/重建机制那半做了且质量尚可，
  但 checkpoint 内容质量是这个 feature 的灵魂。
- 🔴 **C-H3 stale checkpoint 竞态**（已验证 compression.ts:335/342）：
  `trigger()` fire-and-forget 后立即 `tryInsertCheckpointRebuildBoundary()` 读文件——
  读到的是上一版 checkpoint；validation 失败也不传播，主循环误以为双成功。
- 🟡 C-M1 validator 对自产 checkpoint 形同虚设（机械生成必过自验）；
  C-M2 COMMITMENT 动词 'run' 在 inspection 句式误判；
  C-M3 rebuild 首条 tail 消息无 token cap（超大消息撑爆 24K 配额）；
  C-M4 tmp+rename 跨挂载点 EXDEV 风险。
- 🟢 C-L1 测试零覆盖 §4-§11 内容正确性（H1 因此漏过自测）；C-L2 §11 正则脆弱；C-L3 单例不可注入。

### 会话 D：2.4 收尾
- 🔴 **D-R1 A/B 对照未跑**：eval runs 最新 2026-04-29，无 6 月产物，零分数证据。
- 🔴 **D-R3 孤儿开关**：`CODE_AGENT_DISABLE_PROVIDER_VARIANT` 仅 providerVariants.ts 自用，
  eval-ci / run_eval.sh 零引用，run metadata 无 variant 维度——跑了也无法归因。
- 🟡 **D-Y1 PROMPT_VERSION v5→v6 误 bump**：本 commit prompt 内容零改动，bump 制造虚假
  telemetry 边界；且 diagnosticVersions 不感知 disable flag，A/B 两臂都报 sys-v6，
  roadmap 备注"按 promptVersion 对比"的方案被判死。
- 🟡 D-Y2 自带 prompt 时变体注入语义不一致（orchestrator 跳过 vs messageBuild 照注，1a2636151 既有）；
  D-Y3 覆盖面与 MiMo 差距（2 套 addendum vs 12 套整 fork，gemini/beast 缺位）roadmap 未如实写明。
- 🟢 顺带发现：CLAUDE.local.md 引用的 docs/knowledge/{eval-tracking,key-decisions,session-history}.md
  均已不存在，评测跟踪"唯一真理来源"断链。

## 处置建议

**立即止血（不等返工）**：
1. dream cron 改默认关（或 A-H1 门收紧前不自动运行）——否则 7 天后开始自动写弱验证记忆
2. D-Y1 的 PROMPT_VERSION 回退 sys-v5（或让 flag 影响上报版本），止住 telemetry 污染

**返工单（按 finding 编号回给实现方，走 per-finding TDD）**：
- B：3.2 distill 整单重做（原提示词可复用）
- C：C-H1（writer 真子代理化 + §4 接 task 数据源）+ C-H3（trigger await/读写协调）
- A：A-H1（阈值随 token 数缩放 + sessionId 限定 + 批内去重）+ A-H3（lastRun 持久化）
- D：实跑 A/B（eval metadata 接线先行）+ 修 roadmap stale 备注

**审计方法论备注**：四会话的"测试全绿 + typecheck 通过"全部成立，但 C 和 D 的核心规格
仍然落空——完成条件里写"演示一次/贴输出"的要求没有被执行端兑现，验收时必须索要
演示证据而不是只看测试条数。scope 锁死护栏有效（零 docs 污染），但"完成定义"护栏
（贴运行证据）需要在下一轮提示词里升级为硬门。

## 处置状态（2026-06-12 收尾，Claude 本会话修复）

**已修（3 个 fix commit，全 TDD）**：
- `fa3aaf326` — A-H1/A-M2/A-M4/A-L1：dream 防幻觉门收紧（阈值随 token 数缩放下限 2、
  逐字短路最短 12 字符、零 token 拒绝）+ 无近 7 天会话不降级全历史 + scope 显式
  if/else + confidence clamp。门收紧后 dream cron 可保持默认开。
- `7792525be` — C-H3：重建边界前 waitForIdle 等待本轮 writer + 写失败 fail-closed
  跳过边界（顺带修正既有测试对该竞态的隐式依赖）。
- `df3bd4eda` — D-Y1：PROMPT_VERSION 回退 sys-v5（无内容改动的误 bump）。

**勘误（审计 finding 复核修正）**：
- A-H3 降级 LOW：cron `every N days` 实际转日历 cron 表达式（`0 0 0 */7 * *`），
  重启不漂移；真实问题是月底间隔近似（29→1 仅 2 天）+ 注册到首跑可能 <7 天。
  顺带发现既有 `intervalToCron` 的 `weeks` 转换语义错误（`0 0 0 * * N` 是"每周第
  N 天"非"每 N 周"），不在本次 scope，记录待修。
- A-H1 细节修正：content 有参与 token 化（审查者称"从未参与"不准确），
  弱点在阈值不随 token 数缩放。

**移交新会话返工（feature 级，非审计修复）**：
- B：3.2 distill 整单重做
- C-H1/H2：checkpoint-writer 真 LLM 子代理化 + §4 接 task 数据源（含 C-M1~M4 一并处理）
- D-R1/R3：variant 维度接进 eval metadata + 实跑 A/B 对照 + 修 roadmap stale 备注
- 遗留 MED/LOW（C-M2 动词误判、C-M3 首条 tail 无 cap、C-M4 EXDEV、A-M3 批内去重、
  A-M5/C-L1 测试强度、D-Y2 变体注入语义統一）：随返工会话一并清

---

## 复核轮（返工产物对抗验收，2026-06-12）

返工三路（distill 重做 / checkpoint 子代理化 / 2.4 A/B 实跑）跑完后再过一轮反方律师。

**distill：✅ converged（0 HIGH）**。三条裁决约束（提案/落盘分离、频率硬门 ≥2、
GAP-005 auto-draft）逐条 PASS；TOCTOU 经 inFlight 互斥 + wx 排他写入双重封闭；
集成测试是真 live harness（真 SQLite + 生产 SQL）。3 个 LOW（测试注释与实际行为偏差、
skill 生产注册路径无 e2e、cron 幂等依赖外部 tag 去重）记录待清。

**checkpoint：复核出 5 finding，3 个已修（commit 107daf22f）**：
- FAIL-1 (HIGH)：waitForIdle 的 await inFlight 对永不 settle runner 无界挂起 +
  跟 pending 链超时 → 改 race(快照, deadline) 严格不超时。
- FAIL-2 (MED)：**我 C-H3 修复留的尾巴**——writerResult undefined 误放行读 stale →
  改 !writerResult?.success fail-closed。
- FAIL-4 (HIGH 安全)：会话内容经 LLM writer 落盘 checkpoint，重建注入下一 session
  system 上下文 = 跨 session 持久化注入通道 → validator 加注入模式扫描止血。
- FAIL-3（90s 同步等待 UX）、FAIL-5（harness 无运行产物佐证）：记录，前者是设计权衡
  待观测数据决定是否调 REBUILD_WAIT_TIMEOUT_MS，后者需补 live 运行日志归档。
- 注意：FAIL-4 是止血非根治，根治需把 writer prompt 里的会话内容当 inert data。

**2.4 A/B：✅ 实跑数据可信**。prompt-real-smoke 8 case 两臂，variant-on avg 83.9%
（[1,1,1,0,1,1,1,0.714]）vs off 75.0%（[1,1,1,0,1,1,1,0]），差值来自单个
git-status case（on partial 0.714 vs off 超时 0），n=8 噪音大，"无回退"结论成立、
不下"提升"结论——roadmap 备注如实写明。

**遗留（移交后续，非阻塞）**：
- B distill 3 LOW、checkpoint FAIL-3/FAIL-5、注入根治（inert data 化）
- dream 桥缺口：runDreamMemoryConsolidation 生产无调用方（五阶段实际靠 LLM 自觉跑，
  代码 FTS 门只测试在用）——distill 新建的 executor 注册表是它欠的桥，dream 迁移
  是独立后续活
- 既有 baseline 失败 13 个（visionAnalysisService 8 + skillDraftQueue 4 +
  SessionRepository 1），源与测试在本轮区间零改动，与返工无关

**工作树问题（需人工裁决）**：docs/ARCHITECTURE.md 被某会话连 stash-pop 冲突标记
（6 处 <<<< Updated upstream / Stashed changes）一起 commit；本会话已将工作树恢复
到 HEAD 干净版以解除 unmerged（commit 能落地），冲突版本备份在
/tmp/ARCHITECTURE-conflict-backup.md，stash@{0}（preserve architecture docs）仍在。
内容裁决留给人工。

## Release-prep addendum（2026-06-12）

发版前补齐了前述 baseline 失败对应的低风险收尾：

- `visionAnalysisService`：保留最后失败原因，空响应返回 `empty_response`，不再误归类为 generic exception。
- `skillDraftQueue`：低价值工具序列名（如 `grep-read-edit`）在写草稿前拒绝，正向样例改为 `source-change-workflow`。
- `SessionRepository.runtimeState`：runtime recovery 测试 schema 与断言补 `parent_task_id` / `parentTaskId`，确保任务树父子关系可恢复。
- `checkpointWriterLive`：live harness 支持 `--output-dir` 并写出独立 `report.md`，保留 git sha、checkpoint、MEMORY、boundary marker 和续作输出。
- `renderer hot-update production verifier`：metadata 与 bundle hash fetch 都有 timeout 和 stage diagnostics，避免生产验收挂死。

贴边回归：`npx vitest run tests/unit/scripts/verifyRendererHotUpdateProduction.test.ts tests/unit/agent/contextAssembly.test.ts tests/unit/services/SessionRepository.runtimeState.test.ts tests/unit/services/desktop/visionAnalysisService.test.ts tests/unit/services/skills/skillDraftQueue.test.ts`，5 files / 81 tests passed。
