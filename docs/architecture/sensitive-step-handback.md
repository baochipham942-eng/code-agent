# 屏幕控制敏感步骤交回用户（Sensitive Step Hand-back）

> ADR-088 · 状态：已拍板（方案 B，2026-11-03）· 实施载体：N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2（一期 · 密码框输入，含 FU2-FU2 字符按键/粘贴补齐）、N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU3（二期 · 支付/验证码点击词表）
>
> 本文是 FU2 / FU3 的**唯一实施规格**：读完本文不需要再问任何问题就能开工。行号会漂移，锚点以 `路径:标识符` 为准（grep 是唯一真源）；文中行号均为 2026-11-03 时点。

## 1. 决策（Decision）

在 native 屏幕控制路径（`mcp__cua-driver__*` 工具族）上，**密码、验证码、支付三类步骤 Neo 永远不代做**：命中即停手，把这一步交回用户亲手完成，Neo 等用户做完后继续。选定的方案是**方案 B（交回用户）**，被否掉的两个方案：

- **方案 A（弹一张可批准、不可记住的卡）**：密码/支付仍由 Neo 代执行，只是逐次问。否决理由：把密码和付款**送进** Neo 的执行链，等于放宽了当前本来就被「按应用记住」绕过、但至少没有产品化背书的敏感面；竞品没有一家这么做。
- **方案 C（直接拒绝，不给继续路径）**：用户得到一个失败态，任务断头。否决理由：失败态没有出路，不是协作。

**Owner 拍板的两条理由**（2026-11-03 决策卡，证据档 N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE）：

1. **与竞品口径一致**：Cursor Grok Bot 对密码 / 通行密钥 / 2FA / 验证码 / CAPTCHA / 支付一律「Take over」交回用户，用户完成后点「I'm done」再继续，产品承诺「The Bot doesn't type credentials and doesn't see your password」；Claude Duet 同口径（产品永远看不到密码，支付等用户本人）。Neo 的交回卡（我来完成 → 完成后继续）与此同构。
2. **收紧而非放宽权限边界**：无论用户按哪个按钮，Neo 都**不执行**这一步——这比今天的现状（一次「记住」后免卡直跑）严格收紧，也严格窄于方案 A（A 在「允许」下仍代执行）。

背景缺口（已隔离实验证实，见证据档 ② 控制臂/处理臂）：按应用授权的匹配只看应用身份——`resolvePreAskGrant` 只消费 `matchAppGrant`（appGrantStore.ts 内部 `match` 仅 `computerAppsMatch` 身份比对，零内容判定），命中即 auto-approve，后续该应用内一切动作（含点「Pay now」、向 AXSecureTextField 打字）免卡直跑。本决策把这个缺口的一角（密码/验证码/支付）改成结构性交回，其余面留给后续单。

## 2. 范围（Scope）

**只管 native 屏幕控制路径**：工具名以 `mcp__cua-driver__` 为前缀的调用（表外未知名按 `cuaToolNeedsAppGrant` 的 fail-closed 口径同属应用动作）。浏览器路径的 CAPTCHA/MFA 交回已有先例 `enforceBrowserCaptchaTakeoverGate`，不在本规格内。

### 一期（FU2 + FU2-FU2）：密码框输入 —— 结构性信号

| 项 | 内容 |
|---|---|
| 工具 | `type_text`、`set_value`（含 invoke 期别名 `type_text_chars`），以及会产出内容的按键调用：`press_key`（单个可打印字符，仅允许无修饰键或单独 `shift`）与粘贴 `hotkey`（`cmd`/`ctrl` + `v`，含 `cmd+shift+v` 等变体，大小写不敏感）。`Return`/`Tab`/`Escape`/方向键/`Delete` 及 `cmd+a`/`cmd+c`/`cmd+tab` 等导航/非粘贴键**刻意不交回**（保留原按应用审批链，避免手输密码后按回车提交二次弹卡） |
| 信号（主） | cuaNarration 缓存 join：`(pid:window_id) → element_index → {role,label}`（`recordCuaResult` 每次 `get_window_state` 成功后由 mcpClient 自动喂，索引跨快照整体替换）。目标 `role` 命中 `AXSecureTextField`（正则先例 `CU_SECURE_ROLE` = `/^axsecuretextfield$/i`，jev 内环注释原文「AX 树里唯一确定性的密码信号」）→ `kind = password` |
| 信号（兜底） | 调用只带 `x/y`（无 element_index）、无元素概念（`press_key` / `hotkey`）或 join 失败时：该 `(pid:window_id)` **最新一次快照**含任一 AXSecureTextField（`readCuaWindowSecureField`）→ 该窗口内的上述文本输入、单字符可打印 `press_key` 与粘贴 `hotkey` 一律交回（窗口级规则，覆盖像素与按键路径，无需逐动作 join 成功） |
| kind | 一期只产出 `password` |

### 二期（FU3）：支付 / 验证码 —— 词表信号

| 项 | 内容 |
|---|---|
| 工具 | `click`、`double_click`、`right_click`（element_index 路径），以及一期之外**目标 label 命中词表的输入类调用**（2FA 短信码输入框常是普通 AXTextField，非 Secure，一期结构性信号接不住——归这里） |
| 信号 | element_index join 到 `{role,label}`，label 命中**窄词表** → `kind = payment` 或 `verification_code`（按命中的词表归属） |
| 词表（起点，从窄开始） | payment：`支付 / 付款 / 结算 / 提交订单 / pay / checkout`；verification_code：`验证码 / 密码 / verification / 2FA / OTP / password`。**禁止**整族搬 `CU_RISK_KEYWORD`（实测其 `upload` 误拦、`preferences` 类分析性误拦；实测三族全漏 `Submit` / `PIN`——词表是概率网，只能当第二道网） |
| kind | `payment` / `verification_code` |

两期共同的判定位置：**早于一切自动放行消费**。敏感判定必须在 `resolvePreAskGrant` 消费（toolExecutor 的 pre-ask 点）与 skill 预授权（`cuaAppGrantForcesClassification` 已把 cua 应用动作排除出 `isPreApproved`）之前完成——否则一张已记住的应用授权会把交回卡直接吞掉。判定顺序：敏感判定 → （未命中才进入）既有按应用审批链。

## 3. 卡片形态（Card form）

同一张底层权限请求，渲染成**有状态的交回卡**。状态机：`asking → waiting-for-user → done | skipped`。

### 状态与文案（全部用户可见串，zh / en 双语；实施时进 `src/renderer/i18n/`，组件里不写裸串）

**标题（asking / waiting-for-user 共用）**
- zh：`这一步请你亲手完成`
- en：`Please do this step yourself`

**正文（按 kind 三选一；`{app}` = 应用名，`{label}` = 元素 label，仅此两变量）**
- password
  - zh：`Neo 不代填密码。请在 {app} 窗口的「{label}」输入框里自己输入，输好后点下面的按钮继续。`
  - en：`Neo does not type passwords. Please type into the "{label}" field in the {app} window yourself, then press the button below to continue.`
- verification_code
  - zh：`Neo 不代填验证码。请自己查看 {app} 窗口「{label}」需要的验证码并亲手输入，完成后点下面的按钮继续。`
  - en：`Neo does not enter verification codes. Please check and type the code for "{label}" in the {app} window yourself, then press the button below to continue.`
- payment
  - zh：`Neo 不代点付款。请在 {app} 窗口亲手完成「{label}」这一步，完成后点下面的按钮继续。`
  - en：`Neo does not click through payments. Please complete "{label}" in the {app} window yourself, then press the button below to continue.`

**三个按钮（全卡只有这三个，永不出现「本次会话始终允许 / 始终允许」）**
| 按钮 | zh | en | 出现于 | 效果 |
|---|---|---|---|---|
| 我来完成 | `我来完成` | `I'll do it` | asking | 状态推进到 waiting-for-user，**不**裁决底层请求 |
| 这步不做了 | `这步不做了` | `Skip this step` | asking、waiting-for-user | 以 `deny` 裁决底层请求 → skipped |
| 完成后继续 | `完成后继续` | `Continue after done` | waiting-for-user | 以 `allow`（一次性，无任何记住选项）裁决底层请求 → done |

**waiting-for-user 提示行**
- zh：`等你完成……完成后点「完成后继续」。`
- en：`Waiting for you… press "Continue after done" when finished.`

**终态行（卡片落定后展示，替代按钮）**
- done：zh `这一步已由你亲手完成，Neo 没有执行它。` / en `You completed this step yourself; Neo did not perform it.`
- skipped：zh `这一步已跳过，Neo 没有执行它。` / en `This step was skipped; Neo did not perform it.`

**无人值守 / 停车卡（收件箱与会话卡）**：没有活的状态机（应答走台账裁决口），渲染为单状态卡：正文（上方 kind 文案）+ 直接给 [完成后继续]（→ `allow`）与 [这步不做了]（→ `deny`）两个按钮；正文首行加提醒：
- zh：`（无人值守任务挂起等你）`
- en：`(Unattended run parked, waiting for you)`

### 永不进任何载荷的信息

被键入的文本与按键内容（`params.text`、`params.value`、`params.key`、`params.keys`、`params.modifiers`）、字段当前值（AXValue）**不得出现在任何载荷里**——权限请求、停车 `argsPreview`、`argsFingerprint` 的输入、通知文案、卡片渲染、模型回话模板、审批台账 / decision ledger 全部包含在内。实施要点：

- 请求 `details` 只带 `kind` 与 `elementLabel`（及展示用 `appName`；元素 label 是公开的界面元数据，不是秘密本体）。
- `buildParkedArgsPreview` 只读 `command/path/filePath/url/changes`，cua 请求天然不带 → `argsPreview` 为空；FU2 不得给交回请求补这些字段。
- `argsFingerprint` 的输入必须先经 `stripSensitiveStepParams`**剔除 `text` / `value` / `key` / `keys` / `modifiers` 参数**（低熵密码或单字符的哈希可被爆破），指纹只覆盖工具名 + 窗口/元素标识。
- 交回调用的 `recordDecision` 台账记录同样必须先经 `stripSensitiveStepParams` 剥掉敏感输入参数再落账——反正这步不会执行，参数本体没有留存价值。

## 4. 载体（Carrier）

承载方式：**既有审批管线的一个 forceConfirm 权限请求**（先例：`enforceBrowserCaptchaTakeoverGate` 同样以 `context.requestPermission` 发 forceConfirm 卡）。由此无人值守停车、needs-input 通知、跨重启存活全部免费获得，不新造通道。

请求形状（FU2 实施）：

```ts
{
  type: 'dangerous_command',        // 与 captcha gate 同型；不带 dangerLevel——这是流程性交回，不是危险红卡
  tool: 'mcp__cua-driver__type_text', // 触发敏感判定的原始工具全名
  forceConfirm: true,               // 关键：隐藏一切「记住」选项（hideStandingGrants）
  reasonCode: PermissionRequestReason.SensitiveStepHandback,  // 新增枚举值
  reason: '这一步请你亲手完成',      // 向后兼容的人读文案，取值走 permissionReasonText（reasonCode 文案唯一来源）
  details: {
    sensitiveStep: {                // 新增 details 字段，只含这两项
      kind: 'password' | 'verification_code' | 'payment',
      elementLabel: 'Password',     // 元素 label，仅此
    },
    action: 'type_text',            // 裸工具名（对齐 captcha gate 的 details.action）
    // 注意：不带 targetApp、不带 text、不带 value
  },
}
```

配套改动（都在 FU2 一期落地）：

1. `PermissionRequestReason` 新增值 `SensitiveStepHandback = 'sensitive_step_handback'`；`permissionReasonText` 的穷尽 switch 会强制补文案：`敏感步骤交回用户`（漏补即编译红，这是既有机制）。
2. `PermissionCard` 以 `reasonCode === SensitiveStepHandback`（或 `details.sensitiveStep` 存在）为判据渲染第 3 节的交回卡分支，替代常规批准按钮组。

**为什么 allow / allow_session / allow_standing 永不铸造授权、也永不执行这一步**（三层独立保证，缺一不可）：

1. **永不执行（结构性）**：敏感门在驱动派发**之前**拦截；`requestPermission` 的应答只用来选 done / skip 两个回话模板（第 5 节），**没有任何代码路径**从这张请求的应答通向原始工具调用。哪怕应答是 `allow`，执行的也是「回话 + 收尾」，不是原动作。
2. **卡侧永不铸造**：`forceConfirm: true` → `hideStandingGrants` 隐藏「会话 / 始终」选项；`saveMemory` 对 forceConfirm 跳过。卡上按不到任何记住形态。
3. **host 侧永不铸造**：请求 **不带 `details.targetApp`** ——`recordHumanGrant` 的 `allow_session` / `allow_standing` 铸造分支都要求 `app?.name`，无 targetApp 即无从铸应用授权。**残余风险必须堵死**：`allow_session` 在无 targetApp 时会回落 `recordApproval`（会话级工具放行记录）——这同样是本流程不许产生的授权。FU2 必须在 orchestrator 应答入口对 `reasonCode === SensitiveStepHandback` 的请求**整体跳过 `recordHumanGrant`**（单一收口点），把任何形态的记住应答降级为一次性语义。

另有一层纵深：敏感判定排在 `resolvePreAskGrant` 消费**之前**，所以即便未来某个 bug 铸出了应用授权，它也压不掉下一次敏感步的交回卡——授权只在敏感判定未命中后才被消费。

## 5. 工具回话（Resolution）

门在拦截点直接返回工具结果（先例：captcha gate 返回 `MANUAL_TAKEOVER_REQUIRED` 形态）；两个出口都是 `success: true`（工具调用正确履行了它的契约：交回 + 如实汇报；不把用户的选择记成工具失败），`metadata.code = 'SENSITIVE_STEP_HANDBACK'`，`metadata.outcome` 区分两态。**两段模板都必须明说这一步不是 Neo 执行的。**

**done（[完成后继续]）**，`metadata.outcome = 'done_by_user'`：

```
SENSITIVE_STEP_DONE_BY_USER — I did NOT perform this step. The user completed "{label}" ({kind}) by hand and pressed continue. Re-read the window with get_window_state before acting again, then continue the task. Do not attempt this step yourself.
```

**skipped（[这步不做了] / 停车超时 / 取消）**，`metadata.outcome = 'skipped'`：

```
SENSITIVE_STEP_SKIPPED_BY_USER — I did NOT perform this step. The user chose to skip "{label}" ({kind}). Continue the rest of the task without it, or ask the user how to proceed. Do not retry this step.
```

停车 24h 兜底超时走 skipped 模板，追加一行：`The hand-back expired unanswered (parked approval backstop), so it counts as skipped.` 模板中的 `{label}` / `{kind}` 来自 `details.sensitiveStep`（不是参数原文）。模板对模型的纪律要求（不代做、不重试、先重读窗口）就写在模板正文里，不依赖模板之外的机制或记忆。

## 6. 无人值守 / 云端行为（Unattended / cloud）

以下全部为**代码实证**（2026-11-03 main，非猜测）：

- **谁算无人值守**：cron / heartbeat / channel 定时会话在创建收口处 `markUnattendedSession`；`isUnattendedSession` 判定。语音通话态（`isLiveVoiceSession`）与无人值守走同一条停车分支。
- **forceConfirm 在无人值守会话里必然停车，不会被任何自动放行吞掉**：
  - 无人值守只读 MCP 豁免（`isUnattendedAllowedReadOnlyTool`）带 `!forceConfirm` 前置——交回请求不享受豁免；
  - `devModeAutoApprove` / `autoApprove[level]` 两条自动放行都在 `!forceConfirm` 门后，且不在停车分支内；
  - 停车分支（`unattended || voice` → `parkApproval`）位于上述判定**之前**：请求写 `pending_approvals` 台账、内存挂 Promise 不设 60s 超时。**运行是挂起（parked）不是失败（failed）**，跨重启可恢复（argsFingerprint + ledgerFaithful 台账行）。
- **通知**：停车口即发 `notifyNeedsInput`，urgent 通道（绕过焦点门）、`markSessionUnread`、按 requestId 去重；renderer 不在前台时另有 host 原生通知兜底。标题 `有操作等你确认`，正文 `无人值守任务请求执行 {tool}，已挂起等待你在收件箱确认。`——FU2 建议（可选）对 `SensitiveStepHandback` 换更贴的正文：`无人值守任务到了一步需要你亲手完成（{kind}），已挂起等你回来处理。`；不改也已经满足「云端/无人值守时提醒用户」的要求。
- **实际超时值**（写死在 `INTERACTION_TIMEOUTS`）：
  - 停车审批兜底 `PARKED_APPROVAL = 86_400_000`（24h）——新 cron/heartbeat 会话用这档：24h 内保持同一 run 等用户，等待期 `beginHumanWait/endHumanWait` 暂停工具计时；到期 deny（`parked approval expired`），run 以 skipped 收尾。
  - 遗留显式终态会话（`isUnattendedApprovalTerminal`，仅旧调用方登记，新 cron/heartbeat 不再登记；被限流的会话即时失去此身份）用 `PERMISSION = 60_000`（60s），到期 deny 并写原因码 `UNATTENDED_APPROVAL_TIMEOUT`。
  - 交互会话无硬超时：有审批 UI 时一直等真人（30min 计时器只留泄漏诊断，不发终态）；无 UI 的 headless 路径 60s fail-closed（editable 工具 5min）。交回卡在交互会话里可以安全地等用户慢慢做完。
  - 用户发新消息 / 取消 run：`drainPendingPermissions` 把未决请求统一以机器 deny 解除 → 模型收到 skipped 模板。

## 7. 分期顺序（Phase order）

**一期 FU2（密码框输入）先行，二期 FU3（支付/验证码词表）其后**，理由：

1. **信号确定性相反**：一期的 AXSecureTextField 是结构性信号（AX 树角色原样可见、零掩码），实测零误拦；二期的词表是概率网——同一语料上宽词表（CU 族）已出现 `upload` 误拦，而 `Submit` / `PIN` / 纯图标按钮三族全漏。先用确定性信号把「替你输密码」这条路焊死，词表从窄开始慢慢放宽，宁可先漏再宽。
2. **风险排序**：密码泄露不可逆且直接（凭据进对话上下文）；支付点击有金额上限与账单可发现性兜底；验证码时效短、损害面最小。
3. **依赖关系**：一期落地 carrier（reasonCode、details.sensitiveStep、交回卡分支、recordHumanGrant 收口、回话模板）后，二期只是新增一个信号源（词表 join）接到同一个门上，不动管线。

## 8. 已知覆盖缺口（Known coverage gaps）

诚实清单，记录已收口的边界取舍与 FU2/FU3 明确**不**覆盖的面（后续单据另立）：

| 缺口 / 边界 | 现状与原因 | 缓解与取舍 |
|---|---|---|
| `press_key` / `hotkey` 打进已聚焦的密码框 | **已覆盖可打印字符与粘贴键，刻意不覆盖导航键**（FU2-FU2）：目标窗口最新快照含 `AXSecureTextField` 时，单个可打印字符 `press_key`（无修饰键或仅 `shift`）与粘贴 `hotkey`（`cmd`/`ctrl` + `v`，大小写不敏感）已走同一窗口级交回门并剥离 `key`/`keys`/`modifiers`；`Return`/`Tab`/`Escape`/方向键/`Delete` 及 `cmd+a`/`cmd+c`/`cmd+tab` 等非粘贴键不交回 | key 事件无目标元素索引，若对登录页一切按键交回，用户手输密码并点「完成后继续」后模型按 `Return` 提交会因快照仍含密码框而二次弹交回卡（卡片通胀）；保留导航键在原按应用审批链是避免卡膨胀的有意取舍 |
| Bash / osascript GUI 输入 | **已被 shell 桌面自动化分类器强制审批，但不进交回门**：`src/host/permissions/shellDesktopAutomation.ts:classifyShellDesktopAutomation` 已识别 `tell [app/application] "System Events" … keystroke\|key code\|click at\|scroll\|mouse down/up`、`pyautogui`/`pydirectinput` 合成键鼠、坐标 token 与桌面 CLI 语法，并在 `toolExecutor` 强制升格审批（`shell_desktop_automation` → `ask`，绕过 Bash 预授权、安全命令白名单与 lenient 档）；但 shell 命令不含 `pid` / `window_id`，无法与 `readCuaWindowSecureField` 做目标窗口 join | 若改成「只要任意已缓存窗口含 `AXSecureTextField` 就把 shell GUI 命令交回」，后台留着一个已读过的登录窗就会误伤无关窗口的自动化命令；因此刻意不接入 `SensitiveStepHandback`，维持 `classifyShellDesktopAutomation` 的强制人工审批 |
| 盲坐标 `x/y` / 无缓存快照与像素坐标点击 | （1）**无缓存快照（盲窗口 / 盲 `x/y` 输入与按键）**：目标 `(pid, window_id)` 从未跑过 `get_window_state` 时，`readCuaWindowSecureField` 返回 `null`（无信号），按 §9 不升格交回；（2）**有缓存快照时的像素坐标（`x/y`）点击**：缓存只存 `{role,label}` 不存 `frame` 几何，`x/y` 无法 join 到具体按钮 | （1）无快照缺口在 `src/host/permissions/cuaSensitiveStep.ts:classifyCuaSensitiveStep` 打 debug 日志留痕：`cua sensitive step: no window snapshot cached, no signal (gap)`（带 `tool`/`pid`/`windowId`），不无差别升格以避免卡片通胀；（2）一期窗口级规则已覆盖有快照窗口内的输入与字符按键/粘贴，二期 FU3 起**点击**的像素路径走窗口级兜底（窗口最新快照含命中词表的带 label 可点击元素才交回）；无缓存快照 / 图标按钮 / 词表外 label 仍是缺口，精确 join 到具体按钮需扩缓存存 `frame`（另立单） |
| 纯图标 / 无 label 按钮 | 词表靠 label，无 label 无从命中 | 词表网的结构性漏报；二期可选 frame+视觉模型辅助，成本另评 |
| `Submit` / `PIN` / 「确认订单」 | 实测三族词表全漏（无对应词条 / 中文组合词） | 词表起点从窄开始、逐条按真机反馈补；接受「先漏再宽」的既定取舍 |
| 整桌面读取（`get_desktop_state` / `get_accessibility_tree` / `screenshot`）不弹卡 | 既有已知缺口（按应用授权体系外），敏感门只拦**动作**不拦**读取** | 读取结果里的密码框 role/value 属另一议题（macOS AX 本身不回密码 value） |

## 9. 故障态与出路（Failure states）

每个故障态都有出路，不允许断头：

| 故障态 | 行为 | 出路 |
|---|---|---|
| 快照缓存缺失（该窗口从没 get_window_state 过，join 与窗口级信号都无源） | 敏感判定无信号 → 按既有按应用审批链走（今日行为），不误交回，并在 `cuaSensitiveStep.ts:classifyCuaSensitiveStep` 打 debug 日志 `cua sensitive step: no window snapshot cached, no signal (gap)` 留痕 | 模型要点元素或确认焦点本来就需要先读窗口；读到即有信号。判定「无信号不升格」是有意取舍：无差别交回全部输入/按键 = 卡片通胀 |
| element_index 过期（页面已变，索引跨快照失效） | 缓存每次快照整体替换，旧索引 join 不到 → 一期落窗口级兜底；二期点击 join 失败按未命中处理（缺口见 §8） | 模型重读窗口后重试即恢复 join；模板已要求 done 后先 `get_window_state` |
| 用户点了「我来完成」但一直不点「完成后继续」（交互会话） | 请求一直挂着（交互路径无硬超时），run 等待 | 用户发新消息或取消 run → `drainPendingPermissions` 机器 deny → skipped 模板，run 继续；下次再遇到同一步重新弹卡（永不记住） |
| 无人值守停车后用户 24h 不回 | 24h 兜底 deny（`parked approval expired`） | run 以 skipped 收尾（不是挂死）；needs-input 通知与未读标记已发；重跑或下次再问 |
| 遗留 60s 终态会话内触发交回 | 60s deny + `UNATTENDED_APPROVAL_TIMEOUT` | 同 skipped；这类会话已冻结新增（新 cron/heartbeat 不登记） |
| 模型无视模板反复重试同一敏感步 | 每次重试弹一张新交回卡 | 模板明写 `Do not retry this step`；重复卡对用户可见可拒；连续 deny 后模型的 anti-spin / 重试预算机制接手（既有机制，不新造） |
| FU2 实施缺陷导致敏感步漏判 | 行为退回今日现状（按应用授权直跑） | 这是「不放宽」方向的失效——fail 方向安全；探针证据档的 scratch 用例族（control/treatment）转成常驻回归测试钉住 |
| 交回卡被恶意/异常路径应答 `allow_session` | FU2 的 recordHumanGrant 收口把记住应答降级为一次性；步骤本身依旧不执行（§4 第 1 条与应答无关） | 双保险都在；回归测试钉「交回应答不产生任何授权行」 |

## 10. 与进行中单据的衔接

- **N-PERM-NL-RULES-K2（policyEngine 自然语言规则）**：本规格落笔时 `policyEngine` 已在 main，但尚无「交回用户」类规则的用户面文案（现有唯一 sensitive 规则是 `Block sensitive env file writes`）。**FU2 动工前先 grep `policyEngine` + 交回**：若 K2 已合入「交回用户」的规则词汇，设置面 / 规则文案与其复用同一套词，避免两套说法。
- **本决策的 ADR 索引行**：`docs/ARCHITECTURE.md` §19 ADR 索引（编号 088）。索引一致性门要求带链接行的目标必须在 `decisions/` 且同号前缀；本决策正文按派单约束落在本文档（非 decisions/ 目录），故索引行以代码格式（非链接）指向本文档——后续若把本文档迁入 `decisions/ADR-088-*.md`，同步把索引行改成链接即可过门。

## 附：锚点清单（grep 校验用）

本文引用的全部代码锚点（`路径:标识符`，2026-11-03 main 全部存在）：

- 权限链：`src/host/permissions/preAskGrant.ts:resolvePreAskGrant`、`src/host/permissions/appGrantStore.ts:matchAppGrant`、`src/host/permissions/appGrantStore.ts:mintAppGrantSession`、`src/host/permissions/appGrantStore.ts:mintAppGrantStanding`、`src/host/agent/orchestratorPermissions.ts:recordHumanGrant`、`src/host/agent/orchestratorPermissions.ts:parkApproval`、`src/host/agent/orchestratorPermissions.ts:drainPendingPermissions`、`src/host/agent/confirmationGate.ts:recordApproval`
- 卡片：`src/renderer/components/PermissionDialog/PermissionCard.tsx:hideStandingGrants`
- 先例与范围：`src/host/tools/vision/browserCaptchaGate.ts:enforceBrowserCaptchaTakeoverGate`、`src/host/permissions/cuaAppTarget.ts:cuaToolNeedsAppGrant`、`src/host/permissions/cuaAppTarget.ts:resolveCuaAppTarget`、`src/host/mcp/mcpToolRegistry.ts:mapCuaToolPermission`
- 信号源与分类器：`src/host/mcp/cuaNarration.ts:recordCuaResult`、`src/host/mcp/cuaNarration.ts:readCuaWindowSecureField`、`src/host/mcp/cuaNarration.ts:narrateCuaToolCall`、`src/host/mcp/mcpClient.ts:recordCuaResult`、`src/host/permissions/cuaSensitiveStep.ts:classifyCuaSensitiveStep`、`src/host/permissions/cuaSensitiveStep.ts:stripSensitiveStepParams`、`src/host/permissions/cuaSensitiveStep.ts:decorateSensitiveStepRequest`、`src/host/permissions/cuaSensitiveStep.ts:sensitiveStepHandbackResolution`、`src/host/permissions/shellDesktopAutomation.ts:classifyShellDesktopAutomation`、`src/host/agent/runtime/desktop/jevCuaStepCandidates.ts:CU_SECURE_ROLE`、`src/host/agent/runtime/desktop/jevCuaStepCandidates.ts:CU_RISK_KEYWORD`
- 判定位置：`src/host/tools/toolExecutor.ts:resolvePreAskGrant`、`src/host/tools/toolExecutor.ts:cuaAppGrantForcesClassification`、`src/host/tools/toolExecutor.ts:buildPermissionRequest`
- 契约与常量：`src/shared/contract/permission.ts:PermissionRequestReason`、`src/shared/contract/permission.ts:permissionReasonText`、`src/shared/constants/timeouts.ts:INTERACTION_TIMEOUTS`
- 无人值守：`src/host/permissions/modes.ts:markUnattendedSession`、`src/host/permissions/modes.ts:isUnattendedSession`、`src/host/permissions/modes.ts:isUnattendedApprovalTerminal`、`src/host/permissions/unattendedReadOnlyTools.ts:isUnattendedAllowedReadOnlyTool`、`src/host/agent/unattendedApprovalTerminal.ts:UNATTENDED_APPROVAL_TIMEOUT`、`src/host/services/infra/notificationService.ts:notifyNeedsInput`
