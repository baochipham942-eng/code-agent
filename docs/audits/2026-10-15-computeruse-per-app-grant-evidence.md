# N-COMPUTERUSE-GRANT-EVIDENCE — 按应用 computer-use 授权真路取证（2026-10-15）

单号 N-COMPUTERUSE-GRANT-EVIDENCE。checkout = origin/main `6ba331a3a`（mq/computeruse-grant-evidence 分支起点，零源码改动）。
本文是证据档的仓内副本；截图 / DOM dump / 日志摘录 / DB 快照在工人机 `~/work/out/N-COMPUTERUSE-GRANT-EVIDENCE/`，队列证据档在 `~/work/evidence/N-COMPUTERUSE-GRANT-EVIDENCE.md`。

## 结论（一句话）

**按应用授权卡在当前 main 的真实模型路径上结构性不可达**：没有任何已注册工具能以 `computer_use` / `Computer` / `computer` 精确名携带 `targetApp` 参数到达 `extractComputerTargetApp`，所以卡永远不会弹出，`app_permission_grants` 永远是空表。#2247 的按应用授权 UI 目前是死 UI，需要一个修复单（注册面或元数据名对齐）才能重新可达。

## 证据链（全部 file:line 以 grep 为准）

1. **带 `targetApp` 的旧工具永不注册**。`src/host/plugins/builtin/computerUse/index.ts:59` `const cuaEnabled = true;`（硬编码）；`computerUseModule` / `computerModule` / `guiAgentModule`（schema 里唯一有 `targetApp` 的三个：`computerUse.schema.ts`、`computer.schema.ts`）只在 `!cuaEnabled` 分支注册（index.ts:69-73）→ 自 #1485 起死代码。
2. **V2 工具注册了但模型拿不到**。`CODE_AGENT_CUA_STATE_V2=1` + 能力已装（capabilities/computer-use.json state=installed）时注册 `cuaStatefulComputerUse`，注册名 `computer_use`（cuaStatefulComputerUse.schema.ts:5），但：
   - schema 无 `targetApp`、顶层 `additionalProperties: false`；
   - **发现面死锁**：deferred 元数据登记名是 `Computer`（deferredToolsData.ts `DEFERRED_TOOLS_META`），`canExposeLoadedTool` 走 `protocolToolNameChecker('Computer')` → `registry.has()` 精确匹配（toolSearchService.ts:525-530、protocolRegistry.ts:43-46、toolDefinitions.ts:58-63）→ false。实测（V2 轮 webserver.log，摘录存 out/v2round-keylog.txt）：模型发 `ToolSearch {"query":"select:Computer"}` → `ToolSearch done { query: 'select:Computer', loaded: 0, total: 1 }`，DEBUG 行 `Computer: searchable metadata has no registered protocol tool`。
3. **cua-driver MCP 路径也铸不出卡**。MCP 工具名形如 `mcp__cua-driver__get_window_state`；`normalizeBrowserComputerCatalogToolName` 只认精确 `computer_use | Computer | computer`（browserComputerActionCatalog.ts:376-386），MCP 名永不命中 → `extractComputerTargetApp`（toolExecutor.ts:1714）返回 null。
4. **默认配置（真用户面）**：web 构建日志（上一轮，数据目录已按 verify-slotless 设计随 `--stop` 销毁，行内容停服前已摘录）：
   - `[Plugin:builtin.computerUse] builtin.computerUse activated (cua mode: 仅 screenshot / ocr_search，桌面控制让位 cua-driver)`；
   - `ToolSearch match is not loaded as a deferred tool: Computer: searchable metadata has no registered protocol tool`；
   - `Failed to lazy-load server cua-driver: spawn cua-driver ENOENT`（web 构建无该二进制；按任务书不扫描 ~/work，仅记录）。

## 真跑记录（无事件注入，全部真实模型轮）

环境：`node scripts/verify-slotless.mjs N-COMPUTERUSE-GRANT-EVIDENCE --source-config ~/work/out/N-COMPUTERUSE-GRANT-EVIDENCE/source-config/config.json`；自定义 provider `custom-glm-coding/glm-5.3`（base URL `https://open.bigmodel.cn/api/coding/paas/v4`，key 来自 `~/.code-agent/.env` 的 `ZHIPU_CODING_API_KEY`，全程不回显）；权限档默认 ask（settings：`autoApprove {read:true, write:false, execute:false, network:false}`，UI toggle 文案「请求批准」）。

- **第 1 轮（10-14，默认配置）3 次尝试**（calc1/calc2/calc3，out/ 有 composer 截图、超时截图、transcript）：全部无卡。模型行为：`delegate_task` 派后台子代理去找 `mcp__cua-driver__*` → ENOENT → 汇报「需要的能力当前不可用」。
- **第 2 轮（10-15，V2 canary `CODE_AGENT_CUA_STATE_V2=1`）3 次尝试**（v2calc1 快答档 / v2calc2 任务档 / v2calc3 快答档）：全部无卡。日志统计（out/v2round-keylog.txt）：ToolSearch×14、Bash×10、task_status×8、terminal_write×4、delegate_task×3、MCPUnified×3、terminal_open×1、glob/Write/Glob×1；**`computer_use` 调用 0 次，含 `"targetApp` 的参数 0 处**。决定性片段：模型 `select:Computer` 被拒（见上）。
- prompt 用任务书原文："Use the Computer (computer_use) tool to observe the app Calculator. Set targetApp to Calculator. Observe only, do not click or type."

## 验收判定（对照任务书逐条）

- ① 真实模型轮 targetApp 弹卡：**NOT MET**（结构性不可达，证据链 1-3 + 两轮 6 次尝试 0 卡）。
- ② 「本次对话/始终允许」后存储证据：**NOT MET（被 ① 阻断）**。DB 快照（out/v2round-code-agent.db）：`permission_decisions` 14 行全是 Bash/terminal_write/Glob/MCPUnified，无一条 `app_grant:` reason；`app_permission_grants` 0 行。Settings > 隐私防线「电脑操作授权」呈空态：「还没有按应用记住的授权。」（out/w4-01-settings-privacy.png / w4-02-settings-privacy.txt）。
- ③ 等待批准时侧边栏带文本标签：**NOT MET**（与任务书预判一致）。真实挂起态（Bash 危险命令卡，同一 SidebarSessionItem 状态槽；computer-use 卡因 ① 不可得）DOM：状态元素仅 `<span aria-label="待确认">`，无 `title`、无可见文本（innerText 空）。执行中态同理：svg + `aria-label="执行中"`。证据：out/w3-01-sidebar-waiting.json、w3-02-sidebar-row.png、v2pending-01-sidebar-status.json。
- ④ 不同应用再次弹卡：**NOT MET（被 ① 阻断）**——没有第一张卡，也谈不上第二张。
- ⑤ 只取证零源码改动：**MET**。`git status --short` 与 `git diff --stat` 对 src/ 与 tests/ 均为空（本分支唯一提交是本证据文档，位于 docs/audits/）。
- ⑥ 预期收益：**未获证实——反向证实**。真跑证明按应用授权在当前用户路径上**不可见、不可用**（0 卡、0 grant 行、空 Privacy 列表），需修复单恢复可达性后重取证。本单零代码改动，无反向变异项。

## 门

- `npm run -s typecheck` 退出码 0（零输出）。
- `node scripts/verify-slotless.mjs --stop <dataDir>` 已停服（NEO_VERIFY_STOPPED 输出存档）；停服后 `pgrep -fl "playwright|chrome-headless"` 仅剩**另一单**（N-HOME-STARTER-CARDS-FILES）活跃驱动的 chrome-headless 树（父进程 8555 run-card-r4.mjs），非本单残留，未动。
- 未使用 Dev 槽；全程 slotless web 构建。

## 判断记录

1. 第 2 轮启用 V2 canary env（仓内 acceptance 冒烟脚本同款门，`scripts/acceptance/surface-execution-computer-smoke.ts:895`），是本 checkout 上唯一能让 `computer_use` 注册的配置；即便如此发现面仍死锁（元数据名 ≠ 注册名），如实双记录。
2. ③ 的等待态用真实 Bash 审批卡取证（同一状态槽渲染路径）；判定按可见文本 vs tooltip/aria 如实写 NOT MET。
3. 打包的 Agent Neo Computer Use 助手 app 不在本 worktree 内，按任务书不扫 ~/work，仅记录 cua-driver ENOENT；且该路径与卡无关（名字永不 normalize 成 computer_use）。
4. 上一轮数据目录（4yfg00）被 verify-slotless `--stop` 按设计销毁（rmSync），其决定性日志行在停服前已摘录于本文；持久工件（transcript/截图/drive.log）在 out/。
