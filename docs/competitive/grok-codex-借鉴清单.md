# Grok Build & Codex CLI → neo CLI 借鉴清单（终稿）

> 来源：xai-org/grok-build（源码+随包手册）、openai/codex v0.151（源码+官方文档+HN/Reddit 用户声音）
> 调研方式：2 路并行探索子 agent（Codex 侦察 / Grok 规格 as-built 对照）+ 2 路对抗评审（call_codex 分类与依赖 / Claude skeptic 锚点核验）
> 日期：2026-08-30 · neo 基线：main e62698ce8a（Ink TUI 一期 + P4 审批卡 + 观测收口均已合并）

## 对抗评审修订记录

**skeptic 锚点修正（7 处）**：
1. A9 turn_diff 锚点错误——桌面 renderer（TurnDiffSummary.tsx）与 legacy CLI（terminal.ts:703）已消费，真正缺口仅 Ink TUI；动作收窄为 Ink 渲染 + `/diff`
2. A5"无通知"——桌面端已有失焦门控系统通知（osNotification.ts `shouldSuppressOsNotification`），CLI 补 OSC 9/BEL 应对齐其语义而非重造
3. A8 措辞——spawn 前已有 `createSanitizedEnv` 控制字符清洗（bash.ts:42），缺的是密钥白名单，不是"没有任何过滤"
4. B1 前提错误——已有 `splitCompoundCommand` 手写 scanner 逐段评估（commandSafety.ts:194,370）；借鉴点重写为"tree-sitter 替换手写 + 规则内联单测 + 离线 check"
5. B5 核销——后台任务机制已是一等公民（backgroundTasks.ts 上限 10/10min/1MB + Process 工具 + shutdownReaper），缺口仅 CLI `/ps` `/stop` UX
6. "233 skill" 口径——仓内只能锚定 ~50 内置，233 为本机运行时口径（含 legacy/用户/marketplace），已注明
7. A1 附注——readline 的 `!` 是 execSync 直通（chat.ts:335）**绕过**权限分类器；Ink 版必须走 toolExecutor 正式链路，且应顺带收口 readline 路径

**codex 分类修订**：A2（@引用）降 B 或切片（精确引用留 A）；A4 拆分（信息行显示留 A，运行时模式切换降 B）；A7 拆分（Ctrl+Q 留 A，Ctrl+Enter send-now 并入 B4 steering）；A10 拆分（/debug-config 升 A，/statusline 个性化降 ❌）；A8 提前到 P0；B5/B7 升 A（轻量版）；B3 升 A 切片（CLI /rewind 入口，仓内疑有 checkpoint 设施痕迹——立项前先 as-built 复核 fileCheckpointMiddleware/session_rewinds）；B1 只升"可检查规则层"切片。
**codex 漏判补充（6 项）**：工具裁剪（--tools/--disallowed-tools，含 subagent 工具面）、TODO/task 面板（planning 地基已在，TUI 无一等公民面板）、Ctrl+R 历史搜索、审批卡 inline diff（文件写入类审批展示变更摘要+可展开 diff）、sandbox profile（战略 B）、project instruction provenance（作为 /debug-config 子项）。

## 终版行动清单（只做 N 件事，按依赖排序）

**P0（安全与执行链路）**
1. **A8 env 密钥白名单注入**——Bash spawn 前过滤 KEY/SECRET/TOKEN glob（现有 createSanitizedEnv 之上）；默认 core + 诊断 + 可回退。是 A1 的前置
2. **A1 `!` shell 直通（Ink 路径）**——走 toolExecutor 正式链路（审计/截断/cwd/超时/权限证据），顺带收口 readline 的 execSync 直通
3. **A6 shell 输出截断展示（前 2 后 3 行）+ 归组 `›` 展开**——成功输出目前完全不可见；也是 /diff 和后台任务输出的 UI 基础

**P1（高频体感）**
4. **B5→A `/ps` `/stop` 后台任务 UX**——机制已在（backgroundTasks），只做 CLI 呈现与控制
5. **A5 终端通知**——turn 结束/审批出现/后台任务完成发 OSC 9→BEL；对齐桌面 `shouldSuppressOsNotification` 失焦语义
6. **A3 审批卡扩充**——Allow all edits this session / never allow / No 附反馈 + **文件写入类审批 inline diff 摘要**（codex 漏判补充）
7. **Ctrl+Q 双击确认退出**——防误触
8. **Ctrl+R 历史搜索**（codex 漏判补充）——低成本高频

**P2（会话回看与恢复）**
9. **A9 `/diff`**——Ink TUI 消费 turn_diff（桌面/legacy 已有，不重复造）
10. **B7→A resume picker**——cwd 过滤 + transcript 预览（现为 ID 式恢复）
11. **B3→A 切片：CLI `/rewind` 入口**——立项前先 as-built 复核仓内 checkpoint 设施（fileCheckpointMiddleware/session_rewinds 痕迹），做掉即对 Codex 的差异化（其用户公开羡慕 Claude Code）

**P3（诊断与规则层）**
12. **/debug-config**（含 project instruction provenance 子项：本轮采用了哪些项目指令/是否截断）
13. **B1 切片：`policy check` 离线验证 + 规则解释**——Starlark/tree-sitter 整体替换留 ADR
14. **工具裁剪（--tools/--disallowed-tools）**（codex 漏判补充）——含 subagent 工具面限制

**B 档保留（需 ADR/架构题，不在本清单排期）**：Approval auto-review（Guardian）、Enter 注入当前 turn + Esc Esc fork + /side（B4 steering，依赖消息泵改造）、Shift+Tab 运行时模式切换、子代理配置层统一、sandbox profile、@ 完整 fuzzy picker（精确引用可提前）、TODO/task 面板依赖的规划呈现。

**❌ 明确不做**：LaTeX/Mermaid 终端渲染、sticky header、/statusline 个性化（当前 StatusBar 已够用）、patch-based 编辑换轨、云端任务委托、半截 rewind（只回滚对话不回滚文件）。

## 我方已领先、不用学（防倒退抄）

- TUI 交互打磨与动效（Codex TUI 被用户公开吐槽"不如 Claude Code"）
- provider 广度（25+）与成本观测；skill 生态（本机运行时 233 个，仓内内置 ~50 可锚定）与 agent team 专家团
- tool_result 密钥脱敏（与 Codex env 注入过滤互补，一事后一事前）
- headless 确认门 fail-fast 语义与三端行为矩阵
- 后台任务机制（backgroundTasks + Process 工具，Codex 也是近期才补 UX）

## 源索引

- Grok Build：xai-org/grok-build；规格已落仓 docs/design/2026-08-29-ink-tui-grok-interaction-spec.md
- Codex CLI：github.com/openai/codex（codex-rs/tui/、linux-sandbox/、agent-roles/）、developers.openai.com/codex（agent-approvals-security、exec-policy、subagents、config-advanced、cli/reference）
- 用户声音：HN #45610266、r/cursor 汇总（chatgptdisaster.com）、OpenAI 论坛 checkpoint 帖（community.openai.com/t/1379508）、issue #11626/#12558
- 我方锚点：正文逐项文件:行
