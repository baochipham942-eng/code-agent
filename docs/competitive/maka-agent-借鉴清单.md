# maka-agent 借鉴清单（给 neo）

> 来源：开源项目 `jackwener/maka-agent`（Electron + npm workspaces 的本地优先桌面编程 Agent）
> 调研方式：12 路并行子 agent（6 能力维度 + 1 侦察 + 3 深挖 + 运行时内核 + 记忆威胁模型）
> 生成日期：2026-06-16

## TL;DR 定位

maka 和 neo 是**同源逆向项目**（maka 的 skill 直接复刻 Claude Code `SKILL.md` 契约，notes/ 有六轮"参照物深挖"）。两者重心相反：

- **maka**：CHANGELOG 全是 Hardening 1-5（稳定性+安全），能力面很薄
- **neo**：能力广度领先（14+provider / 108+工具 / 多入口），但地基没系统加固过

> **结论：neo 用 maka 补三块短板——运行时健壮性、安全契约、桌面质量门。能力面不用学（maka 全面落后）。**

---

## P0 · 运行时健壮性地基（最高 ROI，被多个子 agent 反复指认为 neo 真空）

- [ ] **P0-1 append-only 事件账本**
  - maka：`runs/{runId}/run.json`(原子写 header) + `events.jsonl` / `runtime-events.jsonl`(逐行 append)，与会话消息 JSONL 物理隔离
  - neo 缺口：SQLite 单库，无事件流，无法重放 run 时序
  - neo 落点：`src/main/services/core/databaseService.ts` 旁加事件账本层；**不必全迁 JSONL**——关系查询仍走 SQLite，只把"事件流 + artifact"两类天然 append 数据外置成账本（混合架构最省）

- [ ] **P0-2 保守崩溃恢复**
  - maka：重启**不重放流、不重跑工具**，只把卡在 `running`/`tool_started`/`permission_requested` 的残留 run 修成确定终态（`failureClass=app_restarted`），诊断只存 reason-code 不拷原始 payload
  - neo 缺口：工具中途崩溃直接弃单，用户手动重发
  - neo 落点：启动时 `recoverInterruptedSessions()` 等价逻辑，配合 P0-1 账本

- [ ] **P0-3 单一 canonical event spine + 投影**
  - maka：`RuntimeEvent` 为唯一事实流，StoredMessage / UI events / telemetry 全降级成 projection；配 `ModelHistoryProjector` 显式构造"下一次模型调用看到哪些历史、为什么"（可测可审）
  - neo 缺口：messages / telemetry / decisionTrace 多套存储各自为政，正踩 maka v1 的 *fragmented source of truth*
  - neo 落点：`src/main/context/layers/` 引入显式 ModelHistoryProjector

- [ ] **P0-4 工具执行护栏**
  - maka：active timeout + **watchdog pause/resume**（审批等待时暂停超时计时，避免人工审批被误判超时）+ parked permission 5min 超时 + 失败分类枚举（Abort/RateLimit/Auth/Timeout/Network/Other）
  - neo 缺口：`toolExecutor.ts` "无 active timeout 靠 max_tokens"；user gate 无限等待
  - neo 落点：`src/main/tools/toolExecutor.ts`

- [ ] **P0-5 坏行容错（直击 exit137 / SIGKILL 半写场景）**
  - maka：JSONL 逐行独立 parse，坏行降级为 `system_note`；**无尾换行的末行判定为崩溃 tail 静默丢弃**（`if(!endsWithNewline && lineNumber===lastLineNumber) continue`）；整文件读失败则清空重写
  - neo 缺口：SQLite 单行损坏是盲区
  - neo 价值：零成本恢复你的 SIGKILL 半写痛点

- [ ] **P0-6 并发/路径安全落盘**
  - maka：per-key Promise 队列串行写（`withQueue(key, op)`）+ `temp(${pid}.${ts}).tmp → rename` 原子落盘 + `SAFE_ID_PATTERN=/^[A-Za-z0-9_-]{1,128}$/` 路径白名单
  - neo 落点：补强 `FileCheckpointService`，run/session id 入文件名前正则白名单防穿越

---

## P1 · 安全 / 隐私（对 neo 14provider + 桌面极适配）

- [ ] **P1-1 token 边界静态契约测试（neo 最大缺口 · 0 运行时成本 · 当天进 CI）**
  - maka：`claude-subscription-ipc-boundary.test.ts` 递归正则扫前端可见代码（preload/renderer/ui），禁止 `access_token`/`apiKey`/`refresh_token` 等 token 形 key 出现在 IPC 返回类型/前端字面量；`web-search-boundary.test.ts` 禁 renderer import provider client
  - neo 落点：Tauri 下扫 `src/` 前端目录，纯字符串/正则匹配，零运行时成本

- [ ] **P1-2 诚实 SECURITY.md**
  - maka：区分 load-bearing 边界（OS 账户 / safeStorage at-rest / 沙箱+preload IPC）vs heuristic 安全网（权限引擎 / `redactSecrets()` / URL 白名单）；核心主张"**唯一 enforcement 是 OS，进程内一切筛查都是 UX 安全网**"，限于 heuristic 的报告判 out-of-scope
  - neo 落点：`docs/security/` 写 trust model

- [ ] **P1-3 凭据存储边界**
  - maka：`credential-store.ts` 用 `safeStorage`（OS keychain/DPAPI/libsecret），不可用直接 **throw（fail-closed 无明文 fallback）**；元数据（slug/baseUrl/model）与密文分离；**掩码哨兵 round-trip**：读取返回 `••••••`，回传哨兵=保持原值、回传空串=显式清除
  - neo 落点：对齐凭据优先级链（SecureStorage > 云端 > env），保证 SecureStorage 失败不静默落明文

- [ ] **P1-4 隐私单一权威标志（neo 完全缺）**
  - maka：主进程权威持有一个 `incognitoActive` 布尔，5 条下游 lane（搜索/记忆/遥测/日志/麦克风）各自 **fail-closed**——一个全局开关同时关掉记忆写入/搜索召回/遥测/日志，renderer 不能自证
  - neo 价值：数据不出域桌面场景的合规开关

- [ ] **P1-5 source 隔离 + web_fetch SSRF 护栏**
  - maka：本地私有 source（thread/memory/activity）不静默混入外部 web 结果，web_fetch 单列一类；scheme 白名单(http/https) + 域名后缀黑名单 + 私网网段/重定向 gating + 字节/超时上限 + telemetry 不落 body
  - neo 缺口：多 MCP 混用（github/firecrawl/obsidian）的跨源污染风险点；作为联网工具安全 checklist

- [ ] **P1-6 gateway 安全基线**
  - maka：`127.0.0.1` 绑定 + per-workspace 本地 token + 显式 enable flag + 日志不落明文 secret；出站只读暴露 session/events/health
  - neo 落点：`src/web/webServer.ts` 护栏对齐

- [ ] **P1-7 PermissionDialog 五要素（与权限主线咬合，直接照搬）**
  - maka：① **禁用 Escape**（权限决策必须肯定，不靠默认拒绝）② 破坏性操作红字 + 按钮文案 "I confirm, allow"（非 "Allow"）③ 6 类 reason **枚举化**映射固定文案、**禁拼接用户输入**（防注入）④ "记住"勾选**仅 scoped 到当前 turn** ⑤ Modal A11y：Tab-trap / aria-modal / aria-labelledby
  - neo 落点：`confirmationGate.ts` 对应 UI

- [ ] **P1-8 错误统一脱敏管道**
  - maka：`generalizedErrorMessage()` 6 枚举（auth/timeout/network/provider_unavailable/rate_limit/unknown）+ `redactSecrets()` 二次剥 API key/用户输入/堆栈；**IPC 禁暴露绝对路径，只传 `relativePath`，main 做 realpath 校验**
  - neo 落点：套在 IPC/SSE 边界

---

## P2 · 桌面质量门 + 工程方法论

- [ ] **P2-1 真窗口冒烟（可移植到 Tauri · neo 大空白）**
  - maka：`desktop-real-window-smoke.mjs` 用 `child_process.spawn()` 拉起 Electron 二进制 + 监听 stdout `[real-window-smoke] diagnostic` JSON 断言；覆盖启动→窗口缩放→移动→modal 开关→键盘导航→交互后健康
  - neo 价值：能测**原生窗口缩放/拖拽/焦点环**（Playwright MCP 测不到原生 chrome），比 Playwright 更轻

- [ ] **P2-2 三个静态门（0 成本直接抄）**
  - maka：`check-console.mjs`（正则禁 `console.*`，白名单豁免）/ `check-a11y.mjs`（自研 lint：icon 按钮缺 aria-label、正 tabIndex、dialog 缺 label）/ `check-stale-dist.mjs`（mtime 比对，src newer than dist 即 fail）
  - neo 落点：纯 Node 源码 walk，与框架无关，今天就能进 CI，配 in-source `// a11y-allow:` 注释

- [ ] **P2-3 视觉回归别硬 diff（学 maka 的教训）**
  - maka：Electron/字体亚像素漂移让 byte/SHA diff 全噪（70/88 PNG 每次都变），**先做"结构门"**（PNG 存在/magic header/尺寸 1x或2x/最小 1024B/体积漂移容忍 ±15%）；pixelmatch 像素 diff 留到稳定场景（artifact-pane/first-run）；`MAKA_VISUAL_SMOKE_FIXTURE=<scenario>` 喂真实数据生成 light/dark/narrow 三套 baseline
  - neo 落点：多变体命名基线（theme×viewport×motion），Playwright 抓图

- [ ] **P2-4 design-system.md 当"契约"**
  - maka：写死 token/组件态/反模式，规则"任何 PR 破坏规则必须同一 commit 更新本文档"；禁硬编码 hex/cubic-bezier/`z-index:9999`，改用 z-index 注册表 + 命名缓动；标识符（model ID/API key/路径）强制 mono；`prefers-reduced-motion` 塌到 0.01ms；组件 5 态契约（loading/error 归属 surface 不归 button）
  - neo 落点：`docs/designs/` 建设计系统契约

- [ ] **P2-5 PR 模板五段 + merge gate**
  - maka：UI PR 必答 contract/flows/test/fixture/security 五段，12 道闸门"跳过任一即 release-no-go"；先靠人工 review 兜底（自动化基建未交付）
  - neo 落点：`.github` PR 模板，务实先人工门

- [ ] **P2-6 AgentFlow 可插拔抽象**
  - maka：`interface AgentFlow { run(ctx): AsyncIterable<RuntimeEvent> }`，解耦"调用归属（Runner）"与"怎么 step model/tool（Flow）"；默认 `AiSdkFlow`，子 agent 用 `InvocationContext.branch` 串同一棵事件树
  - neo 价值：让 `AgentLoop` 退化成一种 Flow 实现，未来插 ReAct/Plan-Execute/多 agent 不动主干；neo 现有 SpawnGuard 子 agent 可借此获得可观测/可回放

- [ ] **P2-7 懒加载 skill catalog + 复用 Claude Code SKILL.md 契约**
  - maka：`skills.ts` 系统 prompt 只放清单（name+desc，上限 12 个/~18KB），正文用 Skill 工具按需拉+截断（24000 字符）；`allowed-tools` 仅信息性，真正闸门是 PermissionEngine（skill 不能放宽权限模式）
  - neo 缺口：产品自身**无终端用户扩展能力**（现有 skill 都在开发环境层）；让用户已有 `~/.claude/skills` 被产品直接继承

- [ ] **P2-8 竞品深挖方法论本身**
  - maka：notes/ 六轮结构化"参照物深挖" + `docs/maka-capability-audit-v1.md` + "先写 PR-plan+gate 再落地"
  - neo 价值：反哺自进化闭环（Observe→Grade→Experiment→Synthesize），也是现成作品集叙事素材

---

## neo 已全面领先 · 不用学

| 维度 | neo | maka |
|---|---|---|
| 多 agent 编排 | Orchestrator + Loop + SpawnGuard 真跑子 agent | 单 flow，仅占位钩子（branch/transferToAgent 未实现）|
| MCP 生态 | MCP 客户端（github/firecrawl/obsidian/playwright）| 不支持，硬编码 6 工具闭集 |
| 联网/浏览器 | playwright+firecrawl+vision，实现完整 | 仅 Tavily 环境变量占位，无实现 |
| voice/多模态 | 有 | spec-only（无音频管线）|
| slash command | 已落地 | 停在设计笔记 |
| provider 广度 | 14+ + fallback chain | 单一 AI SDK 抽象 |
| 权限 | 4 层链（classifier→hook→enforcer→user gate）| 单层三态 |
| 文件安全 | FileCheckpointService 写前快照可回滚 | 文档未强调 |

## 反面教材（不学）
- `packages/ui/src/components.tsx` 是 **303KB 单文件**——neo 保持组件拆分。

---

## 建议落地顺序（按 ROI）

1. **先做 P0-1/2/5**（事件账本 + 保守恢复 + 坏行/SIGKILL tail 容错）——ROI 最高，直接治 exit137 崩溃痛点
2. **顺手做 P1-1**（token 边界静态契约测试）——纯正则、零运行时成本、当天进 CI
3. **P2-2 三个静态门**同样当天可加
4. P1-7 权限弹窗五要素 + P1-8 错误脱敏管道——和权限/安全主线一起做
5. 其余按排期推进

---

## 多模型评审修订（Codex + Gemini，2026-06-16）

> 把本清单的三档分类丢给 Codex（艾克斯）+ Gemini 做独立交叉评审后的修订。真·Kimi 端点当时不可达，第二票由 Gemini 顶。

**对本文件的修正：**

- **P0-1 事件账本：从"待讨论"升为 ✅ 必做（两票一致）。** 它不是"要不要加 JSONL"的小事，是支撑 108+ 工具调度 + 决策追踪**可审计/可回放的脊梁**。SQLite 崩溃恢复只能恢复到文件级，事件 spine 才能恢复到逻辑状态级。**P0-4 watchdog 一并升档**——工具越多，挂死越该被系统级处理。
- **P2-2 三个静态门 / P1-7 权限弹窗：reframe 为"工程可信度证明"。** 对求职作品集，这类治理证据比新功能更值钱——把"我懂工程治理/安全闭环"做成面试官肉眼可见的 UI。
- **P1-4/P1-5 隐私 / SSRF：至少升 🟡。** neo 已有浏览器 + MCP + 108 工具，**攻击面已经存在**，不是"取决于是否主打数据不出域"。
- **P2-1 真窗口冒烟：仍不硬抄。** Tauri 多窗口/渲染层与 Electron 完全不同，**只借测试用例、别抄代码**；但作品集需要桌面真实验收证据，价值别压太低。

**依赖陷阱（评审新增）：**

- **加 JSONL 层别和 SQLite 打架**：若做 P0-1，要么照 maka 原设计把 append-only 事件流与 SQLite **物理隔离**，要么保证同步双写/WAL 对齐——否则崩溃瞬间两边不一致，恢复逻辑反而更复杂。
- **先有 spine 再谈花活**：lody 侧的 CRDT / 移动 review / 双向回写全部依赖这条稳定事件 spine + 身份模型 + 权限审计。顺序反了会"把同步管道问题包装成产品亮点"。

**三方合并"只做 3 件事"**（跨 maka/lody）：① lody G1 接管历史（只读续聊）② 本文件 P0-1/P0-3 事件账本 + spine（配 P0-4 watchdog）③ 本文件 P1-7 权限弹窗 + P1-3 凭据掩码哨兵（打包 P2-2 静态门）。详见 `lody-borrow-list.md` 同名章节。
