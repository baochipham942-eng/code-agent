# N-FIX-FIX-BROWSER-SECRETREF-HARDEN-FU1-FU2-FU2-FU1-PROBE — 逐层定位 secretRef 接管后浏览器在哪一层丢失（纯取证，零产品代码改动）

- 工作树 `/Users/leo/work/wt/N-FIX-FIX-BROWSER-SECRETREF-HARDEN-FU1-FU2-FU2-FU1-PROBE`，分支 `mq/fix-fix-browser-secretref-harden-fu1-fu2-fu2-fu1-probe`，开工时落后 origin/main 8 个提交（无本地提交），已按环境规则 `git rebase origin/main` 快进到 **HEAD = 76ffef4b1**。全部结论、行号以 76ffef4b1 为准。
- 非仓内产物目录：`~/work/out/N-FIX-FIX-BROWSER-SECRETREF-HARDEN-FU1-FU2-FU2-FU1-PROBE/`（下称 OUT）。
- 佐证文件（OUT 内）：`layerA-final2.log`（Layer A 权威原始输出）、`layerA-harness-final.ts`（harness 存档）、`r2-phase-send.log` / `r2-phase-layerc.log`（驱动原始输出）、`r2-webserver.log`（Layer B/C 全量 webserver 日志副本，52251 行）、`prev-round-webserver.log`（前一轮残档）、截图 `r2-shot-b-sent.png` / `r2-shot-b-waiting.png` / `r2-shot-b-end.png` / `r2-shot-c-end.png` / `r2-shot-verify-shot-cmd.png`、启动脚本 `launch-glm-verify-r2.mjs`、驱动 `layer-bc-driver.mjs`、夹具 `origins-server-r2.mjs`、环境回执 `run-env-r2.json`。
- 前一轮残局处理：开工时 OUT 里已有一个今天 17:35–18:02 的中断轮次残留（旧 webServer pid 68708 跑在 rebase 前的旧 dist 上、旧 origins-server pid 66870、两个 `neo-verify-*-work` 目录）。按 AGENTS.md「验收一律新鲜构建」纪律，已 `verify-slotless --stop` 停掉旧实例、kill 旧夹具、删 work 目录；旧日志另存为 `prev-round-webserver.log` 并在 ② 中作为旁证引用。该轮未写证据档（本档为首个证据档）。

## 代码地图（grep 是事实源；行号为 76ffef4b1）

| 环节 | 位置 |
|---|---|
| secretRef 源不匹配 → 触发 takeover | `src/host/services/surfaceExecution/ManagedBrowserProviderAdapter.ts:398-425`（`runtime.control(subject,'takeover')` 在 :403） |
| 读/写动作在 waiting_human 上的等待 | `browserHumanTakeoverWait.ts:20-56`（CAP 100s、POLL 100ms，`src/shared/constants/timeouts.ts:473-476`）；适配器侧 `ManagedBrowserProviderAdapter.ts:286-298`；runtime 侧 `SurfaceExecutionRuntime.ts:310-318` |
| run 结束 → 收掉会话 | `runFinalizer.ts:344-357`（finalizeRun 调 `surfaceRuntime.endRun`）→ `SurfaceExecutionRuntime.ts:716-771`（`grants.revokeForSession` :736、`conversationControl.cancelPendingTakeover` :737、`interrupts.endSession` :738） |
| takeover 请求与 5 分钟超时 | `SurfaceConversationControlService.ts:181-199`（默认 `timeoutMs 5*60_000`）、`SurfaceHumanTakeoverService.ts:25-77`（timer :57-60；`timed_out` → `interrupts.stop` :66-68） |
| stop → 清理 → 释放浏览器 | `SurfaceInterruptService.ts:135-153`（stop/endSession）、:155-185（runCleanup 执行适配器注册的清理）→ `ManagedBrowserProviderAdapter.ts:639-658`（releaseBinding；`stillShared` 跳过释放 :647-654；否则 `browserPool.releaseAgent` :655）→ `browserPool.ts:78-85` → `browserService.ts:300-329`（close 里 `cleanupIsolatedProfileDir` :312 → :1086-1103 `rm -rf` 临时 profile） |
| 会话级 service key（跨 run 必变） | `ManagedBrowserProviderAdapter.ts:197-206`（`surface-<sha256(conversationId,runId,agentId)[:24]>`） |
| 唯一会导出登录态再关窗的路径 | `ManagedBrowserProviderAdapter.ts:726-737/749-782`（`exportResumeStateAndClose` 仅在 abort 的 closeOnAbort 里调用；endRun 释放链**不**导出） |
| 接管条（bar）渲染门 | `src/renderer/components/workbench/BrowserHumanTakeoverBar.tsx:20-44`（`state !== 'waiting_human'` 即 return null，:29-31）；挂载点 `BrowserAgentWindow.tsx:969`（浏览器工作台面板内，不在聊天流里） |

## ① Layer A：host 层（无模型，真 BrowserService = Playwright Chromium + 真 adapter + 真 runtime）

**命令**：`cd <工作树> && CODE_AGENT_DATA_DIR=~/work/out/…/layerA-data npx tsx tests/layerA-secretref-takeover-probe.tmp.ts`（临时未提交测试文件，跑完已删；全文存档于 OUT/`layerA-harness-final.ts`，与本节末尾粘贴一致）。环境：`CODE_AGENT_BROWSER_PROVIDER=playwright-bundled`（headless），`CODE_AGENT_BROWSER_SECRET_X=probe-secret-value-x`，`CODE_AGENT_BROWSER_SECRET_X_ORIGINS=http://127.0.0.1:46171`（**白名单不含**两个夹具 origin 中的 IdP 46172）。夹具：origin1 `http://127.0.0.1:46171` `/login` 设 `probe_app` cookie 并链到 origin2 `/idp`；origin2 `http://127.0.0.1:46172` `/idp` 设 `probe_idp` cookie、已登录时打印 `LOGGED-IN-MARKER`。经 `browserActionTool.execute`（真工具入口）驱动。

**A1 — takeover 之后（仍 waiting_human）**，原始行（`layerA-final2.log`）：

```
[04:30:00.767] setup {"allowList":"http://127.0.0.1:46171","appOrigin":"http://127.0.0.1:46171","idpOrigin":"http://127.0.0.1:46172"}
[04:30:27.058] run1 clicked through to idp {"success":true,"sessionId":"surface_908305f5-…","liveUrl":"http://127.0.0.1:46172/idp"}
[04:30:27.058] A1 pre-type url settled {"liveUrl":"http://127.0.0.1:46172/idp"}
[04:30:27.119] A1 after takeover (waiting_human)
  result={"success":false,"code":"SECRET_REF_ORIGIN_MISMATCH"}
  sessionStateAfter="waiting_human"  runtimeSessionState="waiting_human"  errorContainsContinue=true
  browser.serviceKey="surface-b51cf191e5399777610fa924"  poolHasAgent=true  bindingServiceKey 同左
  browser.profileId="isolated-surface-b51cf191e5399777610fa924-browser_session_1793853025554_4n28px"
  browser.running=true  browser.activeTab="http://127.0.0.1:46172/idp"
  cookies=["probe_app@127.0.0.1","probe_idp@127.0.0.1"]   ← exportStorageState 实读
  isolatedDirs=["isolated-surface-b51cf191e5399777610fa924-…-4n28px-…"]（临时 profile 目录在）
[04:30:27.120] A1 surface events（关键两条）:
  {"seq":14,"phase":"human","status":"waiting","summary":"Sign-in needs you: this site is not allowed for the secret","controls":["resume","stop","end_session"]}
  {"seq":15,"phase":"human","status":"waiting","summary":"Surface control takeover waiting","controls":["resume","stop","end_session"]}
```

结论 A1：窗口活着（running=true、tab 停在 IdP 页）、两域 cookie 都在、会话 waiting_human、事件流带 `resume` 控制——**接管本身工作正常**。

**A2 — 仍在 waiting_human 时调用 `runtime.endRun(identity1)`**（模拟「委派后台任务以 completed 收账」时 runFinalizer 真实会做的事）：

```
[04:30:27.144] A2 endRun(identity1) returned {"elapsedMs":24}
[04:30:27.145] A2 after endRun while waiting_human
  before={"serviceKey":"surface-b51cf191e5399777610fa924","poolHasAgent":true,"profileId":"isolated-…-4n28px","running":true}
  poolHasAgentDirectAfter=false                 ← 池条目已释放（直接探测，未经过再取用）
  after.bindingServiceKey=null  after.running=false  after.activeTab=null   ← 窗口已关
  profileIdGone=true  isolatedDirsNow=[]        ← 临时 profile 目录已 rm
  finalSessionState="completed"                 ← 会话终态 completed
[04:30:27.145] A2 control resume after endRun threw Cannot resume a Surface session while completed.
[04:30:27.145] A2 surface events 追加:
  {"seq":16,"phase":"cleanup","status":"running","summary":"Ending Surface session and releasing control","controls":["stop"]}
  {"seq":17,"phase":"human","status":"cancelled","summary":"Human takeover cancel","controls":["end_session"]}
  {"seq":18,"phase":"cleanup","status":"succeeded","summary":"Surface session ended and control was released","controls":[]}
（同一时刻 BrowserService 日志：`[BrowserService] [INFO] Closing browser...` → `Browser closed, all tabs cleared`，见 layerA-final2.log 原文）
```

结论 A2：**复现**。endRun 在 24ms 内完成整条链：revoke → `cancelPendingTakeover`（有效——pending takeover 被以 `Human takeover cancel` 收掉）→ endSession/stop → runCleanup → releaseBinding → `browserPool.releaseAgent` → `BrowserService.close()`（窗口关闭 + **临时 profile 目录删除**，cookie 随之消失）→ 会话终态 `completed`，事后任何 `resume` 都抛 `Cannot resume a Surface session while completed.`。

**A3 — 用户晚到的 Continue + 同会话新 run**：

```
[04:30:27.145] A3a late Continue threw Cannot resume a Surface session while completed.
[04:30:27.368] A3a new run in same conversation
  run1={"serviceKey":"surface-b51cf191e5399777610fa924","profileId":"isolated-…-4n28px"}
  run2={"serviceKey":"surface-11ce90ed519828487396c8d3","profileId":"isolated-surface-11ce90ed519828487396c8d3-…"}
  sameServiceKey=false                            ← 新 run 必然新 key（key 含 runId）
  pageMarker="IDP-LOGIN-FORM"                     ← 新 snapshot 里 IdP 显示未登录
  cookiesRun2=["probe_idp@127.0.0.1"]             ← probe_app 消失（probe_idp 是本次访问 /idp 时新发的，判据是 probe_app）
[04:30:27.374] A3b run2 secretRef mismatch again {"code":"SECRET_REF_ORIGIN_MISMATCH","state":"waiting_human"}
[04:30:27.374] A3b resume while waiting_human ok {"state":"running","sameTab":"http://127.0.0.1:46172/idp","running":true}
```

结论 A3：**复现**。晚到 Continue 无效（会话已 completed）；新 run 新 service key + 新临时 profile，旧 cookie 不随行（`probe_app` 缺席）；对照实验 A3b 证明**只要 run 没结束**，Continue 在同一窗口同一 tab 上恢复 running——丢失点不在接管机制，而在 **run 结束这条链**。

**Harness 脚本**（跑完即删的 `tests/layerA-secretref-takeover-probe.tmp.ts` 全文，存档 OUT/`layerA-harness-final.ts`，此处粘贴省略重复的 import 块——完整 260 行见存档；关键结构）：

```ts
// 双 origin 夹具 + 真 BrowserService + 真 adapter/runtime + 真 browserActionTool
const appServer = await startOrigin(46171, 'app', idpOrigin);   // /login 设 probe_app cookie，链接 IdP
const idpServer = await startOrigin(46172, 'idp', appOrigin);   // /idp 设 probe_idp cookie，已登录打印 LOGGED-IN-MARKER
resetManagedBrowserProviderAdapterForTests(); resetSurfaceExecutionRuntimeForTests(); resetApplicationRunRegistryForTests();
registry.start({ runId:'probe-run-1', sessionId:'probe-conversation-a', workspace: process.cwd() });
await exec(run1, { action:'navigate', url:`${appOrigin}/login` });
await exec(run1, { action:'click', selector:'#go-idp' });        // 有机跳到 IdP（白名单外）
const typed = await exec(run1, { action:'type', selector:'#pw', secretRef:`env:${SECRET_NAME}` });  // A1
await runtime.endRun(identity1);                                  // A2
try { await runtime.control(subject1,'resume'); } catch (e) { … } // 晚到 Continue
registry.unregister(identity1.runId); registry.start({ runId:'probe-run-2', … });               // A3 新 run
await exec(run2, { action:'navigate', url:`${idpOrigin}/idp` }); // 读 serviceKey/profile/cookies
// A3b 对照：再触发一次 mismatch → runtime.control(subject2,'resume') → 同窗口恢复
```

## ② Layer B：无槽 web 构建 + 一轮真 GLM（glm-5.3，业主订阅）

**环境**（取舍见「判断与取舍」#1）：先按票面原样跑 `node scripts/verify-slotless.mjs N-FIX-…-PROBE`（顺带新鲜构建 dist），回执：

```
NEO_VERIFY_MODEL=custom-tokenrhythm/deepseek-flash
NEO_VERIFY_URL=http://127.0.0.1:53850
NEO_VERIFY_DATA_DIR=/var/folders/…/neo-verify-N-FIX-…-PROBE-wple1V
→ node scripts/verify-slotless.mjs --stop …wple1V ⇒ NEO_VERIFY_STOPPED=…wple1V
```

随后用 GLM 订阅复刻同一无槽机制（`OUT/launch-glm-verify-r2.mjs`，`--stop` 兼容 state 文件；provider `custom-glm-coding`、baseUrl `https://open.bigmodel.cn/api/coding/paas/v4`、key 取自 `~/.code-agent/.env` 的 `ZHIPU_CODING_API_KEY`、model `glm-5.3`）：

```
NEO_VERIFY_MODEL=custom-glm-coding/glm-5.3
NEO_VERIFY_URL=http://127.0.0.1:55204
NEO_VERIFY_DATA_DIR=/var/folders/…/neo-verify-N-FIX-…-PROBE-bIZHCA
```

webServer 环境注入：`CODE_AGENT_BROWSER_PROVIDER=playwright-bundled`、`CODE_AGENT_BROWSER_SECRET_X=probe-secret-value-x`、`CODE_AGENT_BROWSER_SECRET_X_ORIGINS=https://app.example.test`（**白名单不含两个夹具 origin**）。夹具（OUT/`origins-server-r2.mjs`）：origin1 `http://127.0.0.1:46181`（/login、/done）、origin2 `http://[::1]:46182`（/idp、/signin）。UI 驱动（OUT/`layer-bc-driver.mjs`，Playwright 真 UI）：dogfood 账号登录 → composer 发用户话 → 循环应答授权卡（共 5 张，全部点允许，回执见 `r2-phase-send.log` 的 `permission-allowed` 行）→ 状态翻转即截图。

**用户话（Layer B）**：「请把下面这件事委派成一个后台任务去做，用 delegate_task 工具派活，你自己不要直接操作浏览器：打开 http://127.0.0.1:46181/login 这个登录页，把密码填进页面里的 #pw 密码框，密码用密钥引用 env:CODE_AGENT_BROWSER_SECRET_X（浏览器工具的 secretRef 参数）。派完活告诉我后台任务已接单即可。」

**GLM 回放摘要**（原始行取自 `r2-webserver.log`，行号标注）：

| 时间（UTC，日志原时戳） | 事件 | 原始行 |
|---|---|---|
| 04:40:29.958 | 用户话进 AgentLoop | `[AgentLoop] Message: 请把下面这件事委派成…` |
| 04:40:44.771 | 前台 turn 调 `delegate_task` 成功（16ms） | `Tool execution completed { toolName: 'delegate_task', success: true }` |
| 04:40:50.800 | 前台 run 收账 | `[CompletionSummary] persisted run completion contract { status: 'completed' }` |
| 04:41:01.318 | 后台任务起浏览器（isolated profile） | `[BrowserService] Launching managed browser via playwright-bundled (headless, profile=isolated)` |
| 04:41:31.884 | **secretRef 源不匹配**（白名单外） | `Result 1: success=false, error=This step needs you: the page is on http://127.0.0.1:46181, which is not listed in CODE_AGENT_BROWSER_SECRET_X_ORIGINS. …The browser now belongs to the user…waits until the user presses Continue…` |
| 04:41:31 | 会话进 waiting_human（紧邻行） | `sessionState: 'waiting_human'`（log :14102） |
| 04:41:31.960 / 32.317 | Surface 直播流停（与田测 FB-578 相同的 `waiting_human / client_stop`） | `[SurfaceLiveStream] Surface live stream stopped { … reason: 'client_stop' }`（:14088/:14105） |
| 04:42:05.619 | 后台模型按指引收尾（不再调工具、出文本） | `[AgentLoop] Loop decision: continue (none) - normal` |
| **04:42:05.691** | **后台任务以 completed 收账（mismatch 后仅 34 秒，当时仍 waiting_human）** | `[CompletionSummary] persisted run completion contract { sessionId: 'session_1793853617885_98d1ff4a', status: 'completed' }`（:14519-14523） |

任务结束后的权威状态（`POST /api/domain/surfaceExecution {action:getSnapshot}`，04:52 实测）：

```json
{"sessionId":"surface_213d0c1b-…","runId":"session-work-1793853644765-fj8cob","agentId":"default","state":"completed","writable":false,"controls":[],"activeTargetUrl":"http://127.0.0.1:46181"}
{"sessionId":"surface_c148b14c-…","runId":"user-browser-link:83b3e760-…","agentId":"user-browser-link","state":"running","writable":true,"controls":["pause","takeover","stop","end_session"],"activeTargetUrl":"http://127.0.0.1:46181"}
```

**截图与我的判读（图都亲眼看过）**：
- `r2-shot-b-waiting.png`（04:41:34，waiting_human 期间）：**接管 UI 当时是出现的**——中栏会话卡带紫色「需要你接管 / Surface control takeover waiting」、徽标「等待你接管」，右侧浏览器面板显示 App login 页、悬停提示「暂时无法继续操作页面」；但 `BrowserHumanTakeoverBar`（`takeoverPausedHint` 底条 + Continue 按钮）**未渲染**。
- `r2-shot-b-end.png`（04:54，任务结束后）：**没有任何接管条/接管卡/Continue 按钮**；聊天行显示「浏览器 已完成」「1 个代理 · 完成」；右侧面板仍停在旧登录页。
- 票面命令同款 `node scripts/verify-shot.mjs "$NEO_VERIFY_URL" r2-shot-verify-shot-cmd.png --viewport 1440x900` 出图成功（回执 `NEO_VERIFY_SHOT=…`）：图内是应用外壳「加载中…」+「请求批准」按钮（全新浏览器无会话上下文），不带对话内容——与既往轮次结论一致（该命令用于验证 harness 可用，对话态截图以上面两张为准）。
- **②的直接回答：任务结束时聊天里看不到接管条**。接管 UI 只在 waiting_human 的 ~34 秒窗口内存在，endRun 把会话打成 completed（`controls: []`）后消失；`BrowserHumanTakeoverBar.tsx:29` 的 `state !== 'waiting_human'` 即 return null，且该组件只挂在浏览器工作台面板（`BrowserAgentWindow.tsx:969`），本就不在聊天流里。
- **谁判定任务完成**：委派后台任务自己的 AgentLoop——模型拿到 mismatch 结果里「告知用户、然后停下等回复」的指引（`browserHumanTakeoverWait.ts:59` `WAITING_HUMAN_MODEL_GUIDANCE`），输出最终文本结束 turn（`Loop decision: continue (none) - normal`），`runFinalizer.finalizeRun`（`runFinalizer.ts:344-357`）落 `completed` 收账合同并调 `SurfaceExecutionRuntime.endRun`——正是 A2 那条收链。
- 旁证：中断前一轮（旧 dist）同样形态，`prev-round-webserver.log`：01:54:00 mismatch → 01:54:18 `Closing browser...` + `Browser closed` → 01:54:18.284 `status: 'completed'`。旧轮无 UI 附加共享，窗口当场被关掉（与 FB-578 桌面现场一致）；本轮 web 构建有 user-browser-link 共享，`releaseBinding` 的 `stillShared` 分支跳过关窗（代码 `ManagedBrowserProviderAdapter.ts:647-654`），窗口**孤儿化存活**（pid 55990、profile 目录 21:0x 仍在）——两种变体都断流：关掉=登录态没了，孤儿=新任务接不回去。

## ③ Layer C：用户「已手动登录」后的 Continue + 新委派任务是否复用浏览器

**用户话**：「我已经自己在浏览器窗口里手动登录完成了（在 IdP 页面点了 Sign in）。请再派一个后台任务（delegate_task）去确认：用浏览器打开 http://127.0.0.1:46181/done，告诉我页面是否显示 APP_DONE_PAGE，以及 o1_cookie 是 yes 还是 no。如果浏览器里没有已打开的标签页就如实说明你看到了什么。」

GLM **按剧本走了**（两轮都走了 delegate_task 路线，无需按 ③ 的备用条款重跑更明确的用户话；如实记录）：05:05:22 `delegate_task` 成功；后台任务 `session-work-1793855122644-0s9cdx` 于 **05:07:04.809 全新起了一个浏览器实例**（`[BrowserService] Launching managed browser via playwright-bundled (headless, profile=persistent)`——个人默认服务，不是 Layer B 那把 `surface-e48dfc5cd8b4de92616c3538` 隔离窗），05:07:10.923 导航 `/done`，页面文本 `APP_DONE_PAGE o1_cookie=no`，05:07:29.973 / 05:07:51.710 两次收账 completed。代理的原话（`r2-shot-c-end.png` 聊天区，亲眼看图）：

> 「**后台没有找到可复用的已打开标签页或已登录实例，是新开浏览器实例访问的**……这次看到的 o1_cookie=no 是全新会话（不带 cookie）下的结果」「浏览器没有任何已打开的标签页，无法复用你手动登录的那个会话」

**证据链**：
- service key：Layer B run = `surface-e48dfc5cd8b4de92616c3538`（隔离 profile 目录名即含该 key 哈希，磁盘实证）；后续任务用的是个人默认服务（`profile=persistent`，且 `code-agent-managed-browser-/` 下**没有**新增隔离目录）——**不同 service、不同 profile**。
- cookie：`/done` 显示 `o1_cookie=no` ⇔ Layer B 窗口里的 `o1_started` cookie 没有跟过来（若复用同一上下文，该 cookie 在）。
- 旧窗孤儿化：Layer B 的 chrome-headless-shell（pid 55990）与隔离 profile 目录在任务结束十几分钟后仍存活但无人认领（--stop 前实测），与桌面现场「窗口被关、profile 被删」是同一断点的两种表现（有无 user-browser-link 共享伙伴之别）。
- 对照（Layer A A3b）：run 不结束时 Continue 在同一窗口恢复——所以 C 层的丢失同样落在 run 结束链，而不是 resume 机制本身。

## ④ 结论表

| 层 | 是否复现 | 证据行（原始） | 责任代码位置 |
|---|---|---|---|
| A（host，endRun 杀接管） | **复现** | `A2 after endRun while waiting_human { poolHasAgentDirectAfter:false, after.running:false, profileIdGone:true, finalSessionState:"completed" }`；`A2 control resume after endRun threw Cannot resume a Surface session while completed.` | `SurfaceExecutionRuntime.endRun`（`SurfaceExecutionRuntime.ts:716`，cancelPendingTakeover :737 + endSession :738）→ `SurfaceInterruptService.stop/runCleanup`（:135-185）→ `ManagedBrowserProviderAdapter.releaseBinding`（:639，releaseBrowser :655）→ `browserPool.releaseAgent`（`browserPool.ts:78`）→ `BrowserService.close`+`cleanupIsolatedProfileDir`（`browserService.ts:300/1086`） |
| B（委派任务在 waiting_human 中收账、条消失） | **复现** | `04:41:31.884 …SECRET_REF_ORIGIN_MISMATCH…` + `sessionState: 'waiting_human'` → `04:42:05.691 persisted run completion contract { status: 'completed' }`（mismatch 后 34s）；结束后快照 `state:"completed", controls:[]`；截图 `r2-shot-b-end.png` 无任何接管 UI | 任务完结判定=委派任务的 AgentLoop 正常 turn 结束（模型服从 `WAITING_HUMAN_MODEL_GUIDANCE`，`browserHumanTakeoverWait.ts:59`）→ `runFinalizer.finalizeRun`（`runFinalizer.ts:344-357`）→ 同 A 层 endRun 链；条不渲染的门在 `BrowserHumanTakeoverBar.tsx:29`（仅挂 `BrowserAgentWindow.tsx:969`） |
| C（后续任务不复用、cookie 丢失） | **复现** | `05:07:04.809 Launching managed browser via playwright-bundled (headless, profile=persistent)`（非 `surface-e48dfc…` 隔离窗、隔离目录零新增）+ 页面 `APP_DONE_PAGE o1_cookie=no` + 代理自述「没有任何已打开的标签页…只能新开一个全新浏览器实例」 | 会话级 key 必随 run 变（`managedBrowserServiceKey`，`ManagedBrowserProviderAdapter.ts:197-206`）+ `ensureBinding` 只认「同会话且一方是 user run」的共享（:449-461，普通 agent↔agent 不共享）+ endRun 释放链不导出登录态（`exportResumeStateAndClose` 仅 abort 路径，:726-737/749） |

## ⑤ 最小修复建议（给 N-FIX-FIX-BROWSER-SECRETREF-HARDEN-FU1-FU2-FU2-FU1-FIX）

断点不在接管，而在「**run 结束 = 会话死刑**」：委派任务按指引正常收账 → `finalizeRun → endRun` 把 waiting_human 的会话 cancel 成 completed、释放 binding（桌面=关窗删 profile；web=孤儿窗）、条消失、晚到 Continue 无效、新 run 必然新 key 新 profile。

- **最小改动位置（行为）**：`SurfaceExecutionRuntime.endRun`（`SurfaceExecutionRuntime.ts:716`）对「`waiting_human` 且有 pending takeover」的会话**不要**走 `cancelPendingTakeover` + `interrupts.endSession`（:737-738），让会话保持 waiting_human 投影（`controls:['resume','stop','end_session']` 继续可见 → 接管卡/条不消失，用户晚点按 Continue 仍命中同一 surfaceSessionId）。
- **保窗与复用（与 N-BROWSER-KEEP-RESULT-PAGE 组合）**：仅保会话不够——释放链还会关窗删临时 profile。复用该单（分支 `mq/browser-keep-result-page`，**未合入**，本仓 main 上尚无 keptBrowserRegistry）已建好的机制：在 `ManagedBrowserProviderAdapter.releaseBinding`（:639，与该单改的同一条释放链）为「takeover 停靠中」的窗注册 kept（`keptBrowserRegistry.register` + 池 `setKept`，跳过 `releaseAgent`/close），临时 profile 因此不删、cookie 不丢；下一个 run 经 `ensureBinding` 现有共享规则（:449-461）扩展到 kept 窗即可认领同 service key 同 profile。不能整体照搬之处：KEEP-RESULT-PAGE 是**模型显式** `keep_result_page` 动作、闲置 30 分钟回收；takeover 停靠是**host 侧**状态驱动，时钟应挂 takeover 的 5 分钟超时（`SurfaceHumanTakeoverService.ts:57-68`，`timed_out → stop` 目前也会关窗，需同样经 kept 语义放行到闲置回收）。两单都动 `releaseBinding`，须一体落或后落者 rebase 前者——FIX 单写明依赖顺序即可，无逻辑冲突。
- **钉死它的那一个测试**：在 `tests/unit/services/surfaceExecution/managedBrowserSecretRefTakeover.test.ts` 追加一例「run end while waiting_human parks the browser」：mismatch → waiting_human 后调 `runtime.endRun(identity)`，断言 (a) 会话仍 waiting_human（或至少 `fake.close` 未被调、pending takeover 未被 cancel）；(b) 随后 `runtime.control(subject,'resume')` 正常 resolve；(c) 同会话新 run 复用同一 serviceKey（复用 ② 已有的 same-service 断言写法）；并沿用 ⑤ 现有 canary 断言保证秘密值不外漏。

## ⑥ 预期收益

- FIX 单可以直接对着**已证实的三层链**写（endRun 杀接管 → 条消失 → 新 run 新 profile 无 cookie），不用再猜「浏览器丢在哪一层」；修复面收敛为 endRun 的 waiting_human 分支 + releaseBinding 的保窗复用两处，且与 N-BROWSER-KEEP-RESULT-PAGE 的 keptBrowserRegistry 明确合流。
- 真机复检（Dev 包：secretRef 源不匹配 → 手动登录 → 点 Continue）预期一次通过：接管卡/条在任务收账后仍在、Continue 命中同一会话、后续任务同窗同 profile 带 cookie（对应 `LOGGED-IN-MARKER` / `o1_cookie=yes` 一类断言）。

## Required local gates（零产品改动的证明）

```
$ git status --short
（空）
$ git diff --stat -- src
（空）
HEAD = 76ffef4b1
```

本单为纯取证：未提交任何 commit；harness 以**未提交临时文件** `tests/layerA-secretref-takeover-probe.tmp.ts` 形式运行并于收尾前删除（存档在仓外 OUT/）。因此任务书里的 typecheck、tsc-tests-ratchet、knip/design-system、eslint-ratchet 等门**不适用**（无任何仓内内容变更），明确说明如上；也未跑全仓检查（按施工环境约束）。

## 判断与取舍（纪律条款）

1. **GLM provider 取舍**：`verify-slotless.mjs` 硬编码计费 provider `custom-tokenrhythm`（key 校验 `sk_tr_` 前缀），任务书明令只用业主订阅、禁 pay-per-token。先原样跑票面命令（拿新鲜 dist + 回执）再 `--stop`，随后用同机制的 GLM 复刻（`custom-glm-coding`/`glm-5.3`/bigmodel coding 端点/`ZHIPU_CODING_API_KEY`，`--stop` 兼容），此模式为 N-APPROVAL-PENDING-STATUS-COPY 等前单验证过的成熟做法。
2. **常驻进程取舍**：夹具 origin 服务器必须跨前台命令段存活、slotless webServer 本就常驻——均按工具级受管后台运行，收尾全部停掉并核验（`--stop` 回执、`pgrep` 残留为零、临时目录计数 0）；前一轮残局（旧 dist 的 webServer、旧 origins-server pid 66870、两个 work 目录）一并停删，旧日志存 `prev-round-webserver.log`。
3. **「用户在页面里登录」的表示**：无头工人机无法真人操作无头浏览器窗口；Layer A 已证 waiting_human 期间两域 cookie 在窗内，Layer C 证后续任务拿不到它们——用户登录步骤由夹具访问即设 cookie 表示，Continue 以聊天后续消息呈现（现场用户按「建议的继续按钮」产出的正是新任务，语义一致）。
4. **Layer C 模型真实路径**：后续任务自选了 `Browser` 工具 `launch`（全新持久档实例）而非 `browser_action` 复用——结果等价（无共享标签、无 cookie），且代理自述与 FB-578「没有已打开标签页、重开全新登录页」同形；如实记录，未重跑（剧本两轮都走了 delegate_task）。
5. **Layer A 判据口径**：`probe_idp` 每次访问 /idp 都会重发，不能作跨 run 判据；判据用只在 run-1 /login 出现过的 `probe_app`（run-2 缺席=新 profile）。另：`get_page_content` 不是已注册 surface 能力（harness 记录在案），页面标记改由 dom snapshot 判定；A2 的 `poolHasAgent` after-快照含探针自身再取用污染，权威值是未经过再取用的 `poolHasAgentDirectAfter:false`。
6. **Layer A 首跑竞态**：click 后 type 抢在 IdP 导航完成前（未 mismatch），已加 URL 落定等待；权威跑=`layerA-final2.log`，早期部分日志保留在 OUT 供对照。

## 收尾清单

- `verify-slotless --stop` 回执：`NEO_VERIFY_STOPPED=…wple1V`（票面实例）、`NEO_VERIFY_STOPPED=…bIZHCA`（GLM 实例）；夹具 origin 服务器已停（连接拒绝实测）；旧轮 webServer/origins-server 已停；`neo-verify-N-FIX-*` 临时目录计数 0；managed chromium 残留 pgrep 为空。
- 临时测试文件已删；工作树 `git status --short` 与 `git diff --stat -- src` 均空。
- 本机无 fleet/ship/rtk，未 push 未合并；无 commit。


## 返修轮（round 2，2026-11-04）：补交 commit

- 返修指摘：上一轮证据档写了 `DONE … 76ffef4b1`（当时 HEAD），但分支比 origin/main 多 0 个提交、无未提交改动——即取证据档未入库，队列按「没交活」退回。本轮只补交付动作，**未重跑任何取证**（①–⑥ 的全部原始数据仍是上一轮在 76ffef4b1 上采集的，佐证文件仍在 OUT）。
- 按环境规则 `git rebase origin/main` 快进到 **HEAD = 64f2ab0c0**。rebase 增量只有 `tests/manual/deliverable-dedup-verify.{mjs,test.ts}`（mq/deliverable dedup verify #2795），不触 surfaceExecution/renderer 任何文件；关键行号在新 HEAD 逐条复验仍逐字成立：`ManagedBrowserProviderAdapter.ts:399`（mismatch 判定）、`:197`（managedBrowserServiceKey）、`:639`（releaseBinding）、`SurfaceExecutionRuntime.ts:716`（endRun）、`:737`（cancelPendingTakeover）、`BrowserHumanTakeoverBar.tsx:28`（waiting_human 渲染门）——正文行号无需改动。
- 本文件即本轮 commit 的全部内容（docs-only，`docs(evidence)` 先例：663846287）；任务书「Not in scope: test files committed」未违反——只提交了证据文档，harness 仍是仓外存档，`tests/` 内无残留临时文件。
- 门适用性更新：本轮仓内变更仅本 markdown 文件，typecheck / tsc-tests-ratchet / knip 三棘轮 / knip-dependency-gate / eslint-ratchet / host-chinese-error-ratchet / 事件 schema 门均无适用对象（零 .ts 变更、零依赖变化、模型可见请求组装未动），明确说明不适用、未跑全仓检查（按施工环境约束）；收尾门由队列统一跑。
- 产品代码零改动证明（commit 后原样粘贴）：

```
$ git status --short
（空）
$ git diff --stat -- src
（空）
$ git diff origin/main --stat -- src
（空）
$ git log --oneline origin/main..HEAD
<本轮 docs(evidence) 提交，仅含本文件>
```

- 无进程收尾负担：round 1 收尾已停清全部本单进程（`--stop` 回执见上）；round 2 复查 pgrep，发现的常驻 webServer 均属其他单工作树（N-STALE-AGENT-CHIP-AFTER-QUIT、N-ROLE-CREATE-DIRECT-DELETE、Agent Neo Dev 应用本体），非本单进程，未触碰。本单相关 verify-slotless / origins-server / managed chromium 残留为零。未 push、未合并（本机无 fleet/ship/rtk）。
