# Changelog

All notable changes to Code Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.32.0] - 2026-08-11

自 v0.31.0 起 main 累计 69 个提交。此版补齐启动、更新、诊断与指挥台可观测性，并将 agent 编排和发版门继续收紧；新增能力与平台级稳定性改进按 minor 发布。

### Added

- **应用级诊断包与会话诊断入口**（#1028）：可导出诊断信息；权限切换失败改为 fail-loud，便于定位现场问题。
- **指挥台只读工具与目标上下文推导**（#1039、#1021）：前台可直接执行查看类操作；目标上下文进入统一推导链。
- **工具错误合同、错误码层与用户文案**（#1017、#1018、#1022）：为工具失败提供稳定的输入约束、错误码和呈现文案。
- **产物角色注册与设计系统 badge/mark 语义 token**（#1020、#1046）：产物职责和设计语义具备可复用的注册表与 token 基础。
- **通知、遥测与记忆能力补强**（#1043、#1057、#1059）：通知接入 `agent:notice`，记忆索引使用稳定前缀，CLI metrics 增加 prompt-cache token。
- **发版与开发槽护栏**（#1051、#1041）：发版证据从登记表派生并反向 fail-closed；开发槽区分“需干净状态”和“需新槽”。
- **生产质量门扩展**（#1033、#1036、#1062、#1068、#1069）：新增中文 host 错误、生产可达性、导出粒度、依赖零容忍及双平台生命周期验收门。

### Changed

- **Agent 编排主线拆分**（#1070、#1076、#1077、#1078、#1079）：将 `agentOrchestrator` 的权限/审批、denylist、模型 override、DAG 初始化和 goal 播种拆为低耦合模块，移除 god-file 白名单豁免。
- **路由与通知收敛**（#1058、#1044、#1055）：深研究改由显式入口和工具承载；通知从日志回流为会话内说明；指挥台写入路由提示统一。
- **依赖与原生 CI 基线更新**（#1038、#1054、#1066、#1067）：AI SDK v7、sharp 0.35.3、better-sqlite3 13.0.3 升级；Rust PR 进入 `cargo test` + clippy 门。
- **生产死代码与证据门判据重构**（#1060、#1063、#1064、#1065）：knip 和生产可达性从净值改为集合/双维基线；本地 stop 验收证据刷新并解除时效。
- **运行时与启动路径整理**（#1031、#1034、#1047、#1048）：遥测读策略补齐，SIGTERM 改由优雅关库路径处理，发版证据 job 与主干证据同步收窄。

### Fixed

- **启动即发消息的 503 窗口**（#1052、#1053、#1074）：服务从“进程已起”改为“已能接单”才放行请求；数据目录 realpath 归一化并修正启动期噪音时序。
- **自动更新与数据库残留**（#1032、#1035、#1040）：更新前优雅停止 webServer，清理 Windows 强杀遗留；陈旧 SQLite `-shm` 自动修复，编译缓存预热挂入实际执行路径。
- **写入边界与后台任务安全**（#1075、#1026、#1027）：收紧 ToolExecutor 对 `$HOME` 的写授权判断；后台任务历史附件和 `run_policy` 可观测性修复。
- **Windows 稳定性**（#1023、#1073）：收割未认领的 WebView2/webServer 孤儿进程；临时目录长路径规避 Windows 8.3 短名触发的 `fs.watch` abort。
- **验收与测试假红**（#1019、#1045、#1049、#1071）：信号终止不再误报 timeout；role 入口与判活谓词补齐；dynamic-workflow fixture 身份层级校正。
- **界面、会话与工具表达**（#1013、#1014、#1015、#1037、#1056）：产物卡与流式工具文案中文化，system 事件投影改登记制，附件预览空 id 防护，日志名收窄。
- **遥测上传稳定性**（#1025）：上传失败使用指数退避与熔断，`42501` 明确归为不可重试。

## [0.31.0] - 2026-08-07

自 v0.30.0 起 main 累计 63 个提交 / 49 个 PR。核心是 ADR-054「会话=指挥台」——前台永不被执行占用、文字与语音统一派活语义，属新增能力，故按 minor 发布。

### Added

- **ADR-054 会话=指挥台**（#982、#985、#978、#964、#997、#998、#1005）：文字路与语音路统一派活语义，前台 run 不再占用会话。`spawn_task` / `steer_task` / `cancel_task` / `task_status` 四工具走 lane + submission_key 幂等；短名（2-4 字符）作为用户可指认的任务句柄，目标不唯一时先 AskUserQuestion 澄清再动手，绝不回落作用于「当前活」。旧「等前台 run 结束再作为下一轮发出」的 UX 语义退役，底层投递基建保留并改名分。
  - 三轮真机验收（A1–C3 全 PASS）暴露的三个根因：① `_meta` 信封泄漏进工具执行参数（见 Fixed）；② 后台子任务的 user 消息灌进父会话推理历史，排序器遇到 user 即止步 ⇒ 存在的 tool result 被误判缺失（`Tool result is missing`），修复点在会话恢复边界——`isMeta` 审计消息继续留 DB 与界面投影，但不再回灌前台模型历史；③ AI SDK 要求 assistant(tool-call) 后紧跟 tool-result，主 loop 的 system 注入与实时 steer 都会插队，故改为按 `toolCallId` 在整段历史中定位并归位，不能只扫到下一条 user/assistant 为止。
- **浏览器二期/三期 + 账号态**（#971、#984、#992、#962）：侧栏浏览器现场、用户地址栏（回车导航、agent 忙确认、URL 回写）、个人 profile 共享与 Cookie 导入入口。
- **Swarm 链路收敛**（#981、#983、#993）：停止全部、渲染挂止血、任务黄条、概览 Todo 成员级、过程可见；审批 UX；单 spawn 转后台的可见性登记。
- **日志能力三切片**（#987、#988、#991）：运行时 correlation context（复用既有 `runTraceContext`，不另造一套）、会话导出包 v2、CLI 本地会话诊断。
- **概览四模块重构**（#960）：任务 / Todo / 上下文 / 产物分区，诊断 UI 删除。
- **上下文分槽**（#977）：会话 / 空间 / 草稿互不串扰，发起会话自动移交挂载。
- **Dev 测试包多槽并存**（#1000、#1001、#1004、#1006）：bundle identifier `.dev[N]` 推导槽位（`.dev` = 槽 1，`.dev2`…`.dev9`），Rust 侧 `dev_slot()` 与 TS 侧 `devSlotFromBundleId()` 同源双实现并各自钉单测——近似形态（`.developer` / `.dev-old` / `.dev0` / `.dev02`）一律拒绝，判错的代价是测试包写进生产数据目录。附 worktree 构建输入引导脚本；cua helper 缓存挪出 `~/Library/Caches`（该目录会被 macOS 清空）。

### Fixed

- **`_meta` 信封泄漏进工具执行参数**（#998）：`injectMetaIntoInputSchema` 把 `_meta` 注入每个工具的 inputSchema，执行前必须剥离；剥离原先只写在 SSE 流式一条路（`buildToolCallFromAccumulator`），另有 7 处直接构造 ToolCall——openaiWrapper / anthropicWrapper / geminiWrapper / claudeProvider ×2 / aiSdkAdapter ×2。`spawn_task` 是全仓极少数设 `additionalProperties: false` 的 schema，成为第一个把这条陈年泄漏从静默变硬拒的调用点（真机表现为「参数校验失败」连挂两次才成功）。收口到 `providers/toolCallMeta.ts` 的 `extractToolCallMeta` 单一 chokepoint，并加 `toolCallMetaStaticContract` 测试——用 TS AST（非正则）扫 providers/ 与 adapters/ 下全部 ToolCall 构造点，**扫描命中 0 个候选时显式失败**，禁止在测量失效时静默放行。第一轮人工枚举漏了 claudeProvider 两处，正是这道门补齐的。
- **工具组组头状态词与标签基线错位 1px**（#1002）：两段字都是 11px，但状态词继承 body 的 Inter、标签是 `font-mono`(JetBrains Mono)；两个栈都不含中文字形，各自回退到不同的系统 CJK 字体，度量不一致 ⇒ 基线差 1px，中文方块字下肉眼可见。统一字体栈修复（不是 `align-items` 问题——改 `items-baseline` 对它无效）。附 e2e：直接落库造一条带失败工具调用的消息，让真实 `ToolStepGroup` 渲出组头再量真实基线；jsdom 不做布局，className 断言钉不住排版几何。
- **会话搜索与列表**（#1003、#1007）：搜索接 FTS（含中文 2 字词兜底），侧栏列表分页、三过滤器下沉 SQL——历史会话此前搜不到也翻不到。
- **专家团「用这个团」三处失联**（#986、#989、#990）：预选前灌全局 recipe store，待命 pills 与发送启动都依赖它找配方；出厂专家团并入渲染端配方目录；交互对齐「请 TA 来」——预选进 composer，不弹主题输入、不直接发起会话。
- **Composer 批**（#966、#969、#970、#972、#973、#976、#994）：静止态四边一致；删光文字后 placeholder 与光标不回来（WebKit 残留占位 `<br>`）；空闲态上边距回 16px（chips 槽位的常驻锚点让 `empty:hidden` 永不生效）；空输入框画不出光标（WKWebView 不给空 contenteditable 画光标，用 `:empty::before` 零宽空格补行盒）；pin 资料并入文字流内联 chip、句中 slash 触发放宽；光标不再落进内联 chip 内部。
- **资料库带入新会话**（#979、#980）：chip 不出现——`setSessionPin` 统一广播；改走分槽移交提速；有材料时收起通用模板卡。
- **欢迎页建议卡**（#995）：会话带了上下文（资料 pin 或空间/项目工作区）就不摆通用建议卡。
- **工具表达统一**（#963）、**产物卡**（#961、#968）：产物卡跟随缩略图收宽不再通栏；动作条三连修。
- **引擎选择器**（#974）、**侧栏层级与全屏 logo**（#965、#973）、**工作目录多处真相不一致**（#975）、**v0.30.0 真机缺陷批**（#958）、**桌面包资源完整性校验**（#959）。
- **本地 lint 门长期失效**（#999）：`.worktrees/` 位于仓库目录内，ESLint 10 会递归发现子目录的 `eslint.config.*`，把每个 worktree 里的 `admin-console/eslint.config.mjs` 都加载一遍；那些 worktree 未装 admin-console 依赖 ⇒ `npm run lint` 与 eslint 棘轮一律 `ERR_MODULE_NOT_FOUND` 崩掉（主树装依赖只能救一个 worktree）。给 lint 脚本与棘轮门加 `--no-config-lookup` + 显式 `--config`，只用仓库根配置；对 `src` 的扫描结果与原来逐条相同，不放宽任何规则。

## [0.30.0] - 2026-08-03

自 v0.29.2 起 main 累计 80 个提交。新增终端、浏览器现场、品牌换标、高对比主题、设计画布编排等能力，故按 minor 发布。

### Added

- **右栏会话终端 + Agent 读写桥**（#883）：用户与 Agent 共享同一个 PTY，Agent 执行的命令用户可实时看到并接手。提交键在全屏 TUI 下必须发 CR(13) 而非 LF(10)——同一动作在 canonical/raw 两种 tty 模式下是两条判定路径。
- **浏览器现场**：B1 浏览器 tab 接 Managed Browser、liveDev 归位 `preview:*`（#867）；终态留影帧留存 `frameByScope` + 置灰留影/摘要卡兜底（#895）；留影帧跟会话一起落盘、一起删（#920）；聊天正文链接落侧栏浏览器（#926，修真机抓到的观测 TTL 30s 隐形失败——渲染层只 `logger.error`，失败对用户完全不可见）。
- **品牌换标**：星芒 N 品牌标与三变体资产、新栖地四橱窗与等待信号词库、实时语音状态栏星球七态；新标铺开含重生成打包图标与旧标退役（#919）；空态页地球可拖拽旋转（#912）；星球形态可达性登记为装饰性兜底（#909）。
- **高对比两套主题接进设置页**（#918、#928）：#918 只补了 `@import` 让 token 有定义，而 390 个文件的 `bg-zinc-*` 走的是 `--zinc-*`，两套 hc CSS 定义 0 个该变量 ⇒ 沿用上一套主题的值、视觉零变化。#928 给两套 CSS 各补 12 个变量（零改业务文件），并加 `themeZincPaletteParity` 门钉死四套键集合齐平。
- **设计画布编排**：分级免审批（#894）、节点拖拽（#901）、审批期间节点被拖走的陈旧坐标检出与标注（#911）、画布优化批合体与三轮审计整改（#896）。
- **实时语音**：打断原子性——`replace_current` 异步确认 + cancel fail-closed（#890）；语速三档 host 侧与 UI（#887、#898）；首次建连等待会话握手确认（#888）；注入新拨号通话连续性（#891）；中途进度回流 + 节流闸 + 日志三元组绑定（#903）；全局热键拨号 `voice.callToggle`（#906）；通话失败留痕与成功率分母修正（#897、#908）；启动期失败分档呈现 + BUSY 引导升级（#889）；token 用量账本（#913）。
- **实时语音指挥台批**（#948、#950、#952）：团会话默认收件人 = 会话级 Lead——显式点名 > `sessions.metadata.teamLead` > 无专家基线，lead 解析不出真身或为系统内置时 fail-closed 回落，与成员条同读 `readPersistedTeamLead` 一个真源（#948）。定向 steer/cancel——`get_active_tasks` 带登记次序编号（活落终态不重排，宁断档不指错），编号查无此活/已终态/不是手上那件一律拒绝并如实说明，绝不回落作用于当前活；多活并行时口播带活名归属（#950）。执行侧 worth-hearing 标记钉在任务轨 `blocked` 跃迁上（执行侧既有的克制词汇，不发明新「重要性」标记），只对节流闸加权：豁免首延迟窗与最小间隔、per-item 上限让一格且留痕，**绝不豁免用户开口抢占**；`milestoneOwner` 从只认 `:milestone-` 改为按首个冒号切，防 `:blocked-` 合成键逃逸上限；派活/口播/丢弃三类事件补 workItemId 维度遥测（受控词表，title/summary 类型上传不进去）；formatNarration 补 milestone 分支——进度与卡点播报不再以「『任务』做完了。」开头（同段文本先断言完成再否认完成，正是历史上三次「状态词被润成已完成」的素材）（#950）。看屏进 Live（Appshots Phase 3）——`capture_screen_context` 窄工具，整屏采集复用 computerSurface 既有管线，`AppshotOrigin` 枚举区分「热键截窗」与「通话采屏」两种来路事实，采集结果 TTL 3 分钟、一次性附着到下一次 spawn/steer（`<appshot>` XML 说明 + 图片附件双写），权限 fail-closed 三态话术，通话脑防幻视钉死——画面不给它看、明令禁说「我看到」（#952）。

- **四条遗漏分支重贴批**（#954、#955）：发版前盘点 23 条未合并分支，19 条内容早已在 main（ship squash 后原分支永远显示未合并 + 同一功能换会话重做时文件名会变），4 条真未上线，逐条重贴。
  - #954 出图前复述句 + 出图后尺寸验收 + 失败收口（重贴 `feat/imagegen-narration`，落后 92 提交）。判定为纯数学（比例容差 5%、四向扩图预期像素），零模型调用。**按新语境改写**：`ExpandArgs` 在这 92 个提交里把 `direction`/`ratio` 改为可选并新增四向独立 `scales`（一次调用做非对称外扩，替代旧的两次付费扩图），旧分支的必填假设既过不了 typecheck 也描述不了 scales 形态；改写为按实际入参形态说话，预期尺寸统一为 `W'=W×(left+right−1)` 单一公式，与 `computeResizeExpandPlan` 反解 scale 同源（两处不同源会让验收句对着**正确**的产出图报「不一致」）。反套话门的 spec 清单同步补入四向形态（手工枚举，注释已标注新形态必须同步加）。新增 `DesignNarrationBar` 规避 `max-lines:1000`（内联版把 `DesignCanvas.tsx` 顶到 1003 行）。
  - #955 输入框区三件：① 侧栏常驻挂载 + `w-60↔w-0` 宽度过渡（200ms，motion-reduce 降级）、窄屏自动收起后回宽屏自动还原（此前只收不还，期间用户手动 toggle 过则以用户为准）、聊天列 8 处 `px-4` 外壳统一为 `.chat-col-pad`（`clamp(16px,4%,48px)`）；分隔线 `border-r` 改画在内层——留外层会在 `w-0` 时残留 1px 竖线。② 发送键 36→28px、圆角方→正圆、四分支同源、图标等比缩小；工具行内边距 左16/右7.5/下16.5（刻意不对称），容器下边 12→18.5px。**刻意不采纳原分支配色改动**（`bg-brand`→`bg-white`）：该版写于仅深色主题时期，此后四套主题铺开，浅色下 `--zinc-900` 是 `rgb(250,250,250)`，白底按钮对比度约 1.02:1 等于隐形；其自带测试的颜色断言同步改写为形态断言。③ 输入框上方 15 个占用者收进四层声明式容器（L1 阻塞 6 / L2 进行中互斥 2 / L3 上下文 3 / L4 建议 4），未登记者拒渲染；**修复旧分支的死锁**——旧版对「自登记活跃态」的 9 个占用者走「未登记即 return null」，而其登记写在自身 effect 里，不挂载则不登记、不登记则不挂载，旧分支 219 行测试全用直写 store 的占位组件从未照到，改为按自闸型/挂载点声明型分流；两处刻意偏离旧分支：L4 让位条件不含 L3（含之则多人会话永不显示能力建议条）、排队引导卡定在 L3 而非 L1（否则每次排队都把成员条收成摘要）；`selectHasBlockingNotice` 删除并迁移唯一消费者，全仓 0 命中无第二真源。**行为变化（有意）**：L4 四项在 L1 在场或 L2 进行中时整层隐藏，此前共存；短暂可恢复，测试双向断言。- **T1 Overview 任务主路径收口**（#878）：Run header + 排队消息投影 + 诊断下沉。
- **IACT `!send` 句中动作重设计**：chip 点击不再把 label 原样当新指令重发，改为套用户表态模板；生成端同步约束禁止把「用户自理」类选项做成 chip（#882）。

### Changed

- **知识记忆三块并入设置→记忆，整窗页退役**（#922）。
- **二级页互斥翻转成默认收口 + 一级页去返回按钮 + 裸图标补尺寸**（#933）。
- **核心操作区上限收成 2 个**（#924）：文字会话整个藏掉实时通话入口，门开在 `resolveLiveVoiceSlot` 唯一分流点，取不到标记按 false（宁少不多）。
- **侧栏 trailing 列全列对齐**（#923）：归档按钮心对心、三档 tier 加号、项目组新建钮。
- **主题盲亮档颜色门 + 存量棘轮**（#931），随后**翻转为默认拦下**（#941）：原门按名字枚举 11 个色板，因而看不见 cyan/rose/indigo/gray/fuchsia/pink/slate/neutral/teal 共 354 处。改为匹配任意色板 + 亮档档位、配显式豁免集（当前仅 `zinc`；删除该项命中由 354 涨至 3369，证明豁免集承重）。354 处全部迁移或标注 `ds-allow`。
- **浅色模式语义色收进主题 token**（#936）：彩色徽标对比度 1.0–1.7:1 全部达标，`text-*` 亮档命中 2275 → 7。分拣判据为「容器背景是否跟随主题翻转」（`bg-zinc-*` 走 `var()` 会翻转需替换，`bg-gray-*` 为字面量不翻转予以保留），不是按类名色号深浅。
- **探测失败只能降级成「不确定」，不能升格成「否定」**（#917）。
- **路由异常接回主对话流**（#927）：原提示挂在随 TaskMonitor 一同消失的卡片上，路由异常对用户长期隐形；同批删死 hook `useCurrentTurnRoutingEvidence`。

### Fixed

- **开机启动 SIGBUS**（#869）：开机全库 VACUUM 堵死 listen 59s + 覆盖安装 SIGKILL 留陈旧 shm。
- **CUA helper bundle id 分渠道**（#870）：三份 helper 同 bundle id 不同 CDHash，TCC 按签名+具体 app 记账而设置页按 bundle 只渲染一行 ⇒ 授权 A 启动 B 必重弹且 UI 无法分辨；修在 launcher 读自身 `Info.plist` 这个 chokepoint。
- **secondary 按钮浅色回归**（#937）：#936 调深 `--zinc-600` 修的是它当文字色时的 2.46:1，但同一色阶同时是 secondary 按钮底色（`bg-zinc-600` 90 处 + `border-zinc-600` 156 处），导致浅色启用态 5.89:1 → 3.08:1，并让 `bg-zinc-600 hover:bg-zinc-500` 的按钮失去 hover 反馈。修法是按钮改用自身语义 token 而非回滚色阶；门内新增 `SECONDARY_BUTTON_HOVER_MIN=1.2`。
- **本机操作页每次进入冻结整个应用**（#938）：`ComputerUseContent` 挂载即发 5 个 Tauri invoke，而这 5 个在 Rust 侧均为非 async `pub fn`——非 async command 在主线程执行，阻塞的是键鼠输入与整个 UI（实测 0.8–3.5s，最大头是 `/usr/bin/swift -e` 起解释器取 AXDocument 的 0.58–0.74s）。修法：签名改 async + 45s 快照缓存 + 移除 `swift -e`。同批修复关设置无法回到会话页。
- **全局热键拨号完全不生效**（#932）：三个独立根因。`events.ts` 对单字符键直接取 `event.key`，macOS 按住 Option 时 WebView 报合成字符（⌘⌥R → `®`），Rust global-shortcut 无法解析 ⇒ OS 从未注册；`main.rs` 聚焦门在 `set_focus()` 后同步读回 `is_focused()` 而 macOS 激活需经 window server ⇒ 必然误拦；整链零可观测。改用 `event.code` 反推物理键位，录制器与匹配器共用同一函数。
- **用户语音转录被误杀且永不落库**（#930）、**实时字幕逐段覆盖与内容倒退**（#934，四根因）、**通话中打字降级为排队**（#935）。
- **token 空值穿模与回写滞后**（#929）：`teardown()` 先清空全局 `active` 再等 1500ms 排水窗，而 token 累加分支有 `active?.id === id` 守卫 ⇒ 排水窗内到达的 `response.done usage` 全被丢弃。改为本通 transport 绑定局部引用 + `accepting` 标志。同批修掉 `.replace('{X}', cond ? a : b)` 往占位符塞兜底词产生的「约暂无数据 tokens」。
- **中文文件名的正文图片 404**（#899）：渲染器编码被当成路径又编码了一次。
- **自动链接在中文正文里吞掉标点和后续汉字**（#921）。
- **deferred 工具解锁后同轮代执行**（#873）：消灭 WebFetch 首调必败与红字机器话术。
- **冷启动恢复的空历史会话不再伪装成欢迎页**（#874）、**新建会话落在已打开空白草稿上时把光标交还输入框**（#915）。
- **流式空窗占位 + 按钮行等打字机追平**（#871）、**流式渲染自然化 + 会话切换骨架屏 + 侧栏归档两修**（#884、#914）。
- **活动轮思考尾置收窄到「正在生长的那条响应」**（#875）、**会话标题竞态**（#868）、**取消尾消息双写**（#892）。
- **全屏 TUI 下不印注入回显**（#916）：它只闪一帧就被整屏重绘擦掉。
- **appshot 缩略图铺满落点矩形**（#940）：`object-contain` 改 `object-cover`；聊天窗与会话区共用同一组件，改一处两侧同时生效。
- **注入卫生**（#879）：reminder 不进用户气泡 + 画布合同收窄 + 浏览器路由分流。
- **`setNativeSnapshot` 丢弃过期快照时返回可分辨结果**（#910）、**surface 终端收敛**（#893）、**surface 会话创建归属 fail-loud 取证探针**（#872）。
- **根级单测门从加进来就在空转**（#886）：vitest 位置参数是子串不是 glob。
- **解开 main 的两条红**（#904）：token-integrity 豁免 + knip 摘 4 个死出口。

- **长期事实持久化被 fire-and-forget，调用方可能读到半完成状态**（#943）：`runFinalizer.ts` 的
  `writeDurableFacts(...)` 走 `.then()/.catch()`，finalizer 不等它完成就返回，事实文件与记忆索引
  可能只写了一半就被读取（表现为间歇性 `ENOENT .../memory/INDEX.md`，负载重时更易撞上）。
  改为 `await` + `try/catch`，失败仍只 `logger.warn` 不抛，fail-soft 语义不变。

- **`dark:` 变体在高对比深色主题下完全失效**（#946）：`tailwind.config.js` 的
  `darkMode: ['class', '[data-theme="dark"]']` 里自定义选择器**替换**了默认的 `.dark`，
  而 hc-dark 的 `data-theme` 是 `high-contrast-dark`，`useTheme.ts` 给它补挂的 `dark` class
  对 Tailwind 无效（原注释「亮暗基类给 dark: 变体用」是错的）。后果是所有
  `text-blue-700 dark:text-blue-300` 类成对写法在 hc-dark 下取浅色分支，深色文字压近黑底。
  改用 `:is([data-theme="dark"], [data-theme="high-contrast-dark"])`，并新增
  `darkVariantThemeMatrix.test.ts` 把「四套主题 × `dark:` 命中与否」钉成状态矩阵
  （用真实 config 过 postcss 编译后抠实际选择器，不硬编码期望值）。
- **选区颜色硬编码，`--selection-*` token 全是死代码**（#946）：`global.css` 四段
  `::selection` 写死 `rgba(20,184,166,.5) !important`，而四套主题各自定义的
  `--selection-bg`/`--selection-text`（hc 两套指向 `--accent-accessible`）**全仓零消费**。
  改为消费 token 并去掉 `!important`。此为 #918/#928 之后**同形状的第三次**——变量定义了没人读。
- **主题批中低档十项**（#946）：欢迎页 `bg-white/[0.03]`/`border-white/[0.08]` 在浅色下白压白；
  通话摘要卡用 rgba 绕过 hex 门；主题双写漂移（`useTheme` 只读 localStorage 而设置页写后端、
  启动不读回）；`index.html` 静态深色导致浅色/hc 用户启动 FOUC；`light.css` 的
  `--text-tertiary` 与 secondary 同值少一档层级；`high-contrast-dark.css` 的
  `--badge-danger-bg` alpha 0.08（同组其余四个都是 0.2）；品牌件与 a11y 细节若干。
- **invokeDomain 错误码穿透 + rewind 横幅噪声收敛**（#947）。
- **dev 包 `installedFrom` 容忍旧 host**（#949）：renderer 热更新会跑在旧 host 上。

### Changed

- **智谱 CogView 出图模型 id 改为可配置**（#945），不再钉死版本号；对价表查价的影响已在注释写明。

### Security

- **关闭设计产物读写两侧的 TOCTOU 窗口 + dataURL 通道内容校验**（#902）。

### CI

- **main 全量门（`main-full-gate.yml`）解开连红**（#943）：该门自 2026-07-25 连红、追踪 issue #668
  累计 100 条失败追评。三条根因：① `s975ExtractedWiring.static.test.ts` 断言源码文本，被 #864
  的折行骗红（代码语义未变），改为断言前把连续空白折成单空格；② 常驻提示词顶破 3000 上限
  （见上）；③ durable facts 竞态（见上）。前两条各配变异验证，证明放宽后仍守得住。

### Performance

- **设置页 23 个 tab 改懒加载**（#942）：首开求值 11663 行 → 1044 行（-91%）。
- **上下文健康缓存**（#900）。
- **寒暄类消息不再为意图分类等一次小模型；非「自动」档不为路由判断去调另一个供应商的快模型**（随 #868 落地）。

### Tests

- **capabilityCenter 单测走 `remoteCapabilityRegistryService` opt-out**（#944）：原先落到真实单例，
  每条约 4s，在 30s 默认超时下机器一忙就冲破变随机红。真实耗时来源尚未定死（已排除真实网络——
  在 fetch 上插过探针一次未被调用），查清前不要移除该 opt-out。

<!-- 语音批（另一会话进行中）的条目在此追加，勿删本注释 -->
<!-- 已落地：#948 团会话默认收件人=Lead -->
<!-- 发版前请确认本节已补齐，并同步 docs/releases/v0.30.0.md 的用户向文案 -->

## [0.29.2] - 2026-07-31

### Fixed

- **发布证据与 main 拓扑对齐**：在 v0.29.1 合并后的 main 提交上重新执行长会话、工具取消和真实 app-host 验收，使证据提交成为正式发布提交的祖先。v0.29.1 因 squash 合并后的证据来源校验失败而未产生分发制品，v0.29.2 是 0.29 功能集的实际分发版本。

## [0.29.1] - 2026-07-31

### Fixed

- **停止动作不再被旧运行记录遮挡**：同一会话启动新任务后，旧 Durable Run 的终态不会再让停止接口误报“没有活动任务”；取消会优先命中当前 RunRegistry，并按精确 `runId` 等待落盘收敛。
- **发布稳定性证据刷新**：重新生成长会话、工具取消和真实 app-host 验收证据，覆盖目录信任阻断后的停止链路。v0.29.0 因证据过期被发布闸门拒绝且未产生分发制品，v0.29.1 是 0.29 功能集的实际分发版本。

## [0.29.0] - 2026-07-31

### Added

- **实时语音进入完整会话链路**：支持可配置的 realtime provider、输入设备选择、口述词表、流式字幕、主动挂断后的任务续接，以及更自然的 turn-taking；语音入口与设置、权限、审批、任务卡和会话摘要使用同一套状态。
- **任务工作区 Overview**：工作区右栏聚合当前任务进程、产物与可执行动作；侧栏新增工作区入口，任务状态读取失败时会停止无效等待，并允许安全重读。
- **项目云协作 P1**：项目空间和成员卡片元数据可以通过 Supabase 跨设备共享；只展示其他成员的只读卡片，并通过 RLS、字段白名单、重试队列、全量补推与归档删除约束数据边界。
- **外部 Agent Engine**：Codex、Claude 与 Grok 等外部 CLI 引擎进入可发现、可配置的 onboarding 和运行链路，模型目录可从本地 CLI 刷新并安全回退。
- **会话 Fork / Rewind 与工作台增强**：支持事务化会话分叉、回退锚点、按会话保存右栏视图，以及预览、画布、文件、终端和概览之间的一致切换。

### Changed

- **权限与人工介入统一**：会话权限档、专家权限、无人值守审批、目录授权、目标级长期授权和飞书回批共享同一套停车与恢复语义。
- **任务与团队状态更可追踪**：主理人、成员条、任务账本、完成证据、依赖排队、父任务停止和 durable recovery 使用统一真源，减少界面状态与实际运行状态分叉。
- **设置与能力中心重组**：模型、语音、人格、专家、技能、连接器、自动化和工作区入口按用户任务重新分组，减少重复入口和不可操作配置。
- **MCP 与 Skill 安装链收敛**：连接器凭据改用安全引用，安装支持取消和回滚，HTTP Streamable 成为推荐传输，旧 SSE 保留兼容提示。

### Fixed

- **语音稳定性**：修复无声上游、响应 watchdog、重连状态、AEC 配置漂移、字幕生命周期、挂断后迟到任务、鉴权失败提示及 dev WebSocket 代理等问题。
- **会话与消息一致性**：修复新会话发送竞态、排队消息不可见、切换会话不落底、工具状态壳不一致、渲染反馈环和完成账本污染。
- **权限与恢复边界**：修复审批响应链、目录信任、重启后 orphan 审批、MCP OAuth issuer 校验、跨运行迟到写入及取消收敛问题。

### Security

- **云协作最小数据面**：`collab_projects`、`project_members`、`project_invites` 与 `collab_cards` 开启 RLS；卡片同步仅允许经过白名单的只读元数据，客户端不上传正文、密钥或本地执行细节。
- **外部能力凭据隔离**：连接器敏感字段不再明文落项目目录；外部 CLI 和 MCP 继续受工作区、权限档与用户确认边界约束。

## [0.28.1] - 2026-07-21

### Fixed

- **create-role/edit-role 的 strict 工具集不再无条件粘滞**：`conversationRuntimeStickySkill.ts` 恢复判定改为三重条件——本会话存在按 `sessionId` 过滤的 pending 角色草稿，或种子仍在最近 3 条 user 消息的访谈窗口内，且种子之后历史里未出现过 `exit_role_flow` 调用；否则不再恢复。此前只要历史里有过 `/create-role` 种子就无条件恢复 strict 工具集，草稿晾着未确认时用户提无关请求也会被锁在 5 个工具里。（#532）
- **landing 页下载区双卡竖排视觉失衡**：下载区由「左文案|右卡片栏」两列 grid 改为文案顶部横条 + 卡片 auto-fit 网格（minmax 320px），Windows 测试版卡片放量后不再把左栏拉出大片空白。（#531）

### Added

- **`exit_role_flow` 工具**（`src/host/tools/modules/roleAuthoring/exitRoleFlow.ts`，strict 白名单内）：模型调用成功后 `ToolExecutionEngine` 同轮清除 `turn.skillToolBoundary` 并 `clearActiveSkill()`，全量工具集立即恢复，草稿保留在确认卡上不受影响。
- **strict 工具集收窄原因注入**：`buildStrictToolsetNotice()`（`skillBoundaryScope.ts`）在 strict 边界激活轮向模型说明当前 skill 名、收窄后的工具清单、"这是流程设计不是故障"，以及退出方式；`messageProcessorUnavailableTools` 的 admission-repair 拦截消息同步带上同一段原因，模型不再只能对用户编"环境受限"。
- **`tool_scope_narrowed` 观测事件**：PostHog 新增事件区分 `strict_skill` 与 `artifact_repair` 两类收窄来源，只报 skill 名与工具数量；`tool_call_failed` 补 `narrowedBy` 字段，方便远程判断失败源头是流程性收窄还是工具真坏。

## [0.28.0] - 2026-07-21

### Added

- **Neo Surface Execution V1**：Browser 与 Computer 进入统一执行控制面，Session、Run、Surface、Agent 与 target identity 全程绑定，支持暂停、继续、人工接管、停止、结束和确定性 cleanup。
- **Browser Adapter V2**：Managed 默认使用隔离 profile；Relay 仅在用户明确授予 tab、domain、action 与 time scope 后复用现有登录态，并在终态归还 tab。新增 frame/element ref fence、上传审批、截图与 DOM/console/network 证据投影。
- **Computer Adapter V2**：原生桌面执行接入相同生命周期与结果语义，同时保留显示器、坐标、系统权限、输入和 helper cleanup 边界。
- **Conversation Execution UX**：会话中直接展示执行状态、语义时间线、权限与人工介入、截图证据、判断结果和产物；支持三并发 Surface Session、跨 Surface 切换及 WorkBuddy 同型任务链。

### Changed

- **证据与恢复进入会话合同**：截图明确区分 captured、analyzed 与 verified；proof、replay、诊断包和 Session export 使用同一脱敏投影，重启后可恢复安全的 continuation 与失败复验上下文。
- **旧入口保持兼容**：保留现有 tool 名、旧消息、replay 与 Session export 读取路径；Browser 与 Computer 通过兼容适配层接入统一控制面。

### Fixed

- **app-host 停止门保持 fail-closed**：隔离验收会显式阻止项目级配置加载，避免 fresh-profile 的目录信任弹窗遮挡停止控件，同时拒绝测试误授予目录信任。

### Security

- **跨 Agent 与越权访问阻断**：grant、lease、observation、output、frame/ref 与 RunRegistry 均校验 owner 和代际；过期引用、跨 Agent 访问、授权外动作和停止后的迟到 mutation 一律拒绝。
- **登录态、输入与证据脱敏**：Managed cookie/profile 不跨 Session 复用；Relay 权限按最小 scope 到期；输入值、cookie、token、剪贴板及截图上下文在 UI、telemetry、proof、export 与诊断包中统一脱敏。

## [0.27.3] - 2026-07-16

### Fixed

- **Windows leg 补发**：v0.27.2 发版时 `build-windows` 挂在 poppler 资源洞上，publish 按设计降级 mac-only 照发，导致 Release 只有 darwin-arm64 / darwin-x64 资产、零 Windows 资产。修复（#398：`../scripts/poppler` 进 `tauri-platform-config.mjs` 的 `MACOS_ONLY_PREFIXES`）晚于 tag，本版把 Windows 三平台矩阵补回。（#398）

## [0.27.2] - 2026-07-15

### Added

- **ADR-040 artifact locator P0 契约地基**：`ArtifactLocatorV1` + 写前 guard（A1/A2/A3），预览坐标与编辑工具坐标从此对账；定位不到时 fail-closed 而非静默改错。（#379）
- **ADR-040 P1 locator 补齐**：PPT presentation package index resolver、Word 段落 locator、上传 PPT 截图选页、生成 PPT producer 切 resolver、locator telemetry。（#385）
- **Poppler sidecar 随包分发**：`pdftoppm` 随包，PPT/PDF 多页截图在干净用户机上开箱即用；`pdfToImages` 数值定序。（#380）
- **Poppler 不可变发版硬门**：双架构制品锁、promotion workflow、源码/许可证/manifest/hash 全链校验，formal release fail-closed。（#385）
- **Poppler 候选发布链**：`promote-poppler-sidecar.yml` 人工派发发布到项目控制的不可变 OSS 前缀 `poppler-sidecar/26.07.0/`，产出 ready lock 供人复核；发布权限与候选构建刻意分离（`build-poppler-sidecar.yml` 断言 `not.toContain('ossutil')`）。verify job 在双原生 runner 真下载 + 过完整 formal gate。（#390）

### Changed

- **Poppler 26.02.0_1 → 26.07.0，依赖闭包钉到单一 homebrew-core 快照**（`9fd96c356`）。此前 lock 只钉 `poppler.rb` 一个文件，17 个依赖仍由 runner 当下的 brew 解析，两架构因此编出不同版本（jpeg-turbo 3.2.0 vs 3.1.4.1、gpgme 2.1.2 vs 2.1.1、libtiff 4.7.2 vs 4.7.1_1）。钉回原 2026-02 快照不可行：那批 formula 用的 `no_autobump! because: :requires_manual_review` 已被 Homebrew 6.x 移除。（#392）
- **ADR-040 C2a 许可证按 26.07.0 重核**：组件集合不变（17 个），但 Poppler 声明从 `GPL-2.0-only` 变为 `GPL-2.0-only OR GPL-3.0-only`，明确择 GPL-2.0-only。分发清单表改由真实候选生成（旧表列着从未随包的 WebP、自称 18 个组件）。新增两条重新评估触发器：lock 版本/commit 变动、组件 `declaredLicense` 与记录不符。（#392）
- **表格上下文带真实行号**：模型自推坐标那条链不再靠数行。（#381）
- **few-shot 选择器不再对产物任务失明**：PPT 任务不再匹配到全编程题语料库；产物意图检测按强/弱信号分级，放开表格/文档/设计三类。（#378、#382）
- **产物任务默认开场改为先落骨架**：常驻层去编程化，完成条件不再写死「改了代码」；新增 `no_stall_before_artifact` 开场形状断言。（#384、#386）
- **CI runner 钉版**：release.yml 与 build-poppler-sidecar.yml 的 macOS runner 全部钉死到具体版本，artifact actions 提到 Node 24。浮动 runner 迁移会静默换掉工具链，已 promote 的哈希将无法复现。（#387、#390）

### Fixed

- **随附源码必须对应实物（GPL §3）**：合规收集与构建分属两个 step/shell，`HOMEBREW_NO_INSTALL_FROM_API` 仅在 `fetch-poppler.sh` 内 export，收集侧 brew 因此退回 JSON API 抓到别的版本源码（实测「二进制 poppler 26.07.0 / 源码 26.06.0」）。改为 job 级 env + `HOMEBREW_NO_AUTO_UPDATE=1`，并新增源码↔二进制版本对账门（剥离 brew `_N` 重打包后缀）。（#392）
- **跨架构组件版本对账门**：`assertCrossPlatformComponentParity` 在造 lock 前逐个比对两架构组件版本，不一致即拒绝 promote。（#392）
- **合规收集丢弃空的上游许可证占位**：zstd 上游 `build/LICENSE` 是 0 字节，撞上清单 bytes 正整数断言；筛完一个不剩时仍 fail-closed。（#388）
- **清单 runner 白名单与 promotion matrix 绑死**：两处分居两个文件、无同步保证，改单边会让候选一律判非原生且要等 6 分钟编译完才炸。（#391）
- **定点反馈坐标对账**：Excel 两维错位根治 + 验收盲区重建。（#377）
- **打包态首装更新链路**：web host 初始化 UpdateService，runtime-assets 签名长期有效。（#389）
- **poppler 发版链纳入 swarm-ci path 过滤**：lock 是 release.yml 真读的数据，此前改它触发不到任何 CI（lock 翻 ready 的 PR 实测 `no checks reported`）。（#393）

## [0.27.1] - 2026-07-14

### Added

- **启动编译与 Shell 环境缓存**：webServer 引导层启用 V8 compile cache，ShellEnvironment 增加带 schema、platform、shell 校验的磁盘缓存与后台刷新，host spawn 到 health 从 2.03 秒缩短到约 0.7 秒，缓存失败时保持安全降级。（#376）

### Changed

- **数据库启动维护提速**：stale FTS 清理改为基于 `user_version` 的一次性维护门，FTS backfill 守卫由全量 `COUNT(*)` 改为 `LIMIT 1` 存在性检查，并为执行事件反连接补充 `(execution_id, phase)` 复合索引，使 DB init 从 5.9 秒降至 11 毫秒。（#374）

### Fixed

- **macOS 临时 Chrome profile 钥匙串弹窗**：仅为一次性系统 Chrome profile 启用 `--use-mock-keychain`，避免反复出现 Keychain Not Found 提示，同时保留持久化浏览器 profile 的真实钥匙串与既有加密 Cookie。（#375）

## [0.27.0] - 2026-07-14

### Added

- **官方 Skill 市场与可信安装链**：设置页可以浏览官方货架、识别新版并手动升级；安装固定到 commit SHA，并校验内容哈希，项目还能覆盖全局 Skill 启用状态。
- **按模型配置推理深度**：模型能力声明统一表达 budget、effort、thinking toggle 等差异，设置页只展示当前模型真正支持的控制项。
- **会话与内容工作流增强**：记忆召回增加分类器路径，Mermaid 支持标注即编辑及缩放平移，长 Markdown 历史渲染减少无效布局开销。

### Changed

- **运行时状态边界收敛**：ADR-038/039 将 turn、control、context health、trace、artifact 和 repair 状态下沉到明确 owner，统一无进展逃生与降级收尾语义。
- **权限拓扑进入执行链**：主任务、队友、异步 Agent、cron 与 background spawn 使用统一拓扑裁决；GuardFabric 的 ask/forceConfirm 语义接入真实工具执行。
- **评测吞吐与隔离**：评测 case 支持隔离 worker 并行执行，同时拒绝被静默忽略的并发配置。

### Fixed

- **取消链路真实收敛**：run 受理时即武装 AbortController，重复停止会串行重投递；`/api/cancel` 只在 registry 或 durable 进入终态后报告成功，renderer 对 `202 cancel_requested` 按原 runId 继续收敛。
- **新会话发送竞态**：发送会等待建会话结果并绑定新会话；创建失败时不会把消息静默送回旧会话。
- **CLI 与恢复一致性**：CLI serve 的取消入口会真实终止 AgentLoop，启动时残留的 cron running 记录会标记为 interrupted。
- **模型能力回退**：修复 vision/reasoning fallback 在 Zhipu 与 MiMo 组合下的能力错配。

## [0.26.4] - 2026-07-12

### Added

- **本地能力首次使用按需安装**：arm64 首次开启语音输入时只下载 `onnxruntime-vad`，首次调用浏览器自动化时只下载 `playwright-browser-runtime`；普通用户可在更新设置中查看状态、下载进度并失败重试。

### Fixed

- **双架构 runtime-assets 正式分发**：macOS arm64 发布 VAD 与 Playwright，x64 发布 Playwright；两侧 manifest、sha256 和 archive 独立签名、上传、验证并写入 `stable/release.json`。
- **Intel VAD 诊断语义**：darwin-x64 的 VAD 明确显示“不适用”，不再计入 missing 或阻断 renderer 热更新。
- **发布门禁**：正式 tag 不再因缺失 `ENABLE_RUNTIME_ASSETS_PUBLISH` 仓库变量而静默跳过组件分发；发布后验证会分别检查 arm64/x64 `/api/update` 的可信 runtime-assets metadata。

## [0.26.3] - 2026-07-12

### Fixed

- **v0.26.2 发布恢复**：补齐 fresh Stability Stop/Recovery smoke，并让 app-host smoke 使用隔离数据目录，避免读取真实用户 MCP 配置造成资源竞争；本版本承接 `v0.26.2` 已推 tag 但被 evidence freshness gate 阻断的发布现场。
- **fresh-profile 首次启动超时**：远程 plugin、skill 和 MCP capability 初始化移出 HTTP listener 与首窗导航关键路径；Durable recovery 在 capability 就绪后继续并保持 fail-closed。

### Changed

- **更新 metadata 权威源收敛**：`/api/update` 只读 GitHub Release 与 OSS stable manifests，不再保留无持久化效果的 Cloud publish 兼容入口。
- **仓库结构与设计契约**：补齐代码、脚本、测试和 workflow 导航边界，增加 repository-structure gate 与根目录 `DESIGN.md`。

## [0.26.2] - 2026-07-12

### Changed

- **更新 metadata 权威源收敛**：`/api/update` 只读 GitHub Release 与 OSS stable manifests，不再保留无持久化效果的 Cloud publish 兼容入口；发布后验证会拒绝非权威 metadata source。
- **仓库结构与设计契约**：补齐 Agent、脚本、测试和 workflow 导航边界，增加自动 repository-structure gate，并建立根目录 `DESIGN.md` 作为 Agent Neo 产品设计契约。

### Fixed

- **fresh-profile 首次启动超时**：远程 plugin、skill 和 MCP capability 初始化移出 HTTP listener 与首窗导航关键路径；桌面壳可先完成健康检查和窗口导航，Durable recovery 在 capability 就绪后继续并保持 fail-closed。

## [0.26.1] - 2026-07-12

### Fixed

- **正式发布的 renderer 热更新一致性**：相同源码现在生成确定性的 renderer bundle；同一发布通道的 OSS writer 串行执行，并以 manifest 作为最后写入的完成标志，避免 main 与 tag 两条 workflow 竞争时混合不同 bundle hash。
- **v0.26.0 发布恢复**：此版本承接 `v0.26.0` 已推 tag 但未创建 GitHub Release 的失败现场，不覆盖或重发原 tag。

## [0.26.0] - 2026-07-12

### Added

- **Durable Run Kernel 与进程级恢复**：核心运行状态、owner fencing、checkpoint 和恢复分发进入统一持久化内核；应用重启后可以按可证明的副作用状态继续、观察或转人工复核。
- **统一多 Agent 执行协议**：Agent Team、Auto Agent、Multiagent 与动态工作流共享执行端口、身份关联和恢复语义，减少不同编排入口在崩溃恢复时的行为分叉。
- **外部 CLI durable lifecycle**：Codex、Claude 等外部 CLI 运行记录可持久化 provider operation、恢复证据和 resume 参数；证据不足时保持人工复核边界，不盲目重放。
- **MCP durable task 与可信工具缓存**：支持可查询的异步 MCP task、结果文件存储和 proven tool cache；只在结果身份、工具能力与允许范围可证明时复用。
- **Unified Graph Runner**：任务 DAG、动态工作流、外部引擎和子 Agent 统一接入 Graph Runner，并通过集中的 GraphEvent compatibility sink 兼容既有消费者。
- **OTel run trace**：run、operation、tool 与恢复链路传播统一 trace context，便于定位跨进程和跨执行器问题。

### Changed

- **启动恢复与生产读路径切换**：应用启动期会恢复可安全接管的 durable run，生产查询优先读取 durable 状态，并保留受控回退与 rollback round-trip 验证。
- **恢复策略更保守**：未知写副作用、外部 CLI resume 证据缺失、工作区或模型工具漂移等场景会进入 `requires_review`，避免重复执行。

### Fixed

- **symlink 越界写入防护**：文件、目录及尚不存在目标经过 symlink 指向工作区外时统一要求确认，避免路径表象绕过权限边界。
- **double ESC cancel 去重**：同步取消标记在请求传播前立即生效，连续 ESC 不会重复触发 cancel fan-out。

## [0.25.1] - 2026-07-11

### Changed

- **生产控制面更抗瞬时故障**：Supabase 依赖增加超时、缓存、陈旧数据回退与断路保护；未认证请求不再为共享密钥额外访问数据库，继续保持 fail-closed。
- **运行目录口径统一**：文档与运行时约定统一到 `~/.code-agent/code-agent.db`，避免排障时误查旧的 macOS Application Support 路径。

### Fixed

- **登录失败提示与会话信任**：认证错误可以从嵌套响应中提取可行动原因；本地退出窗口被显式识别，不会把正常退出误报成会话过期。
- **控制面降级路径**：缓存、采样和断路状态在依赖失败时确定性收敛，避免瞬时 Supabase 故障放大为连续请求失败。
- **远程 MCP 联网稳定性**：Context7、Exa 与 Tavily 连接遇到瞬时网络失败时会做一次有界重试并在重试时使用已配置代理；Tavily 统一使用 Bearer 认证，Exa 显式请求搜索与抓取工具，兼容旧控制面配置。

## [0.25.0] - 2026-07-11

### Added

- **连续共驾指针与系统光晕**：Computer Use 执行时，面板内光标连续跟随；原生桌面任务可显示穿透式系统光晕，并支持多显示器、负坐标与混合缩放。
- **Provider × Runtime 能力证据矩阵**：新增能力矩阵、请求形状 fixture、脱敏 live smoke ledger 与 release blocker，发版不再只靠声明判断渠道是否可用。
- **长会话稳定性金标**：新增历史加载、滚动锚点、持续流式输出、停止收敛和恢复路径的结构化基线与回归门。

### Changed

- **运行隔离继续收紧**：Native Run、工具状态、Agent Team 生命周期和流式快照按 Session / Run 绑定，旧 owner 不能覆盖或清理新 owner。
- **权限与脚手架分档**：新增只读探索档位，并根据模型能力选择更合适的修复脚手架密度；高密度 compact 指令仍由开关控制。
- **评测与发布治理**：compare 实验臂、工具完整性判定、文案门、自动化任务护栏和发布证据门进入持续验证链路。

### Fixed

- **长会话加载历史不再跳视口**：向上加载历史消息时保留当前阅读位置，搜索和流式跟随使用独立证据判定。
- **共驾指针所有权与终态**：外部 Session 不能改变当前光晕，失败显示可重试，终态、卸载和 `end_session` 会确定性隐藏并清理定时器。
- **原生光晕生命周期**：WebView 只创建一次并安全复用，加载代际、隐藏状态和显示器切换不会被旧 worker 或迟到事件污染。

## [0.24.4] - 2026-07-09

### Added

- **Agent engine model discovery**: Codex and Claude engine model catalogs can now be refreshed from local CLI discovery before falling back to bundled catalog data, including newer Claude aliases such as Fable and Haiku.

### Changed

- **Model settings UX**: the model provider settings page now gives the add-provider action a clearer place, explains execution-engine defaults in settings, and removes execution-engine model configuration from the main model switcher.

### Fixed

- **Local/Ollama ghost models**: Local models are no longer shown in the chat model switcher just because the provider entry is enabled. The switcher now requires a current local discovery signal, so uninstalling Ollama or its models hides the stale Local group.
- **Cloud config refresh coalescing**: concurrent cloud configuration refreshes are coalesced to avoid duplicate work and noisy renderer bundle telemetry parsing.

## [0.24.3] - 2026-07-08

### Fixed

- **Claude Code 登录态继承**: Claude Code engine now launches in safe mode while preserving the user's existing Claude CLI auth/session environment, so an already logged-in local CLI is no longer misreported as needing `/login`.
- **Model parameter compatibility**: `gpt-5.5` / `gpt-5.5-pro` requests now use the only supported default temperature `1` across AI SDK and OpenAI-compatible fallback paths. The model settings temperature control is locked with an explanatory hint for these models.
- **Model routing error readability**: raw Azure/LiteLLM temperature and missing-fallback messages are classified as model configuration failures with actionable guidance, while full provider internals stay in logs.

### Changed

- **macOS DMG Finder polish**: future release DMGs keep the standard drag-to-Applications install layout while also setting a cleaner Finder icon-view window, icon size, and app/Applications icon positions.

## [0.24.2] - 2026-07-08

### Fixed

- **macOS DMG install flow**: the release DMG now opens as an installer-style volume named `Install Agent Neo`, with `Agent Neo.app` and an `/Applications` shortcut at the root so users drag the app into Applications instead of running it from the mounted disk image. The macOS release verifier now mounts every DMG and fails if that install layout is missing.
- **Packaged relaunch after force-quit**: packaged launches clear stale `webServer` processes holding the desktop port before spawning the bundled server, and the Node server also clears the port before service initialization. This prevents a killed shell from leaving an old backend that makes the next launch look broken.

## [0.24.1] - 2026-07-06

### Fixed

- **Release packaging for platform-specific Tauri resources**: Windows release builds now delete inherited macOS-only resource keys when deriving the win32 overlay, macOS x64 overlays delete inherited arm64 native resource keys, and macOS release verification accepts both legacy `Contents/Resources/_up_` and current direct `Contents/Resources` layouts.
- Supersedes the failed `v0.24.0` CI tag; no `v0.24.0` GitHub Release was published.

## [0.24.0] - 2026-07-06

### Added

- **@Neo lightweight redesign + cross-session topic continuation**: Neo Tag now uses a lighter work-card flow and can continue project/topic work across sessions with a clearer handoff surface.
- **Evaluation flywheel expansion**: GAIA external anchors, artifact-runnable assertions, trajectory-to-case regression drafts, deterministic approval/clarification simulators, and richer static HTML triage metrics are now part of the eval path.
- **Goal and verification gates**: Goal contracts are injected into eval, verifier snapshots can prove workspace side effects, and failed gates can take a bounded repair path before deciding whether to stop or continue.
- **Cost/context accounting**: cache-aware accounting, prefix hash attribution, compression savings gates, stable request prefixes, and active tool-result pruning improve token-cost visibility.
- **Design/system gates**: token-reference integrity, source-scan self-checks, design bare-radius/z-index/important rules, and brand contrast assertions are wired into the gate suite.

### Changed

- **Settings and command UX**: Settings IA is condensed into fewer first-screen groups; `/agent` routing and `/goal` entry move toward calmer conversational confirmation; settings/navigation i18n debt is reduced.
- **Renderer/desktop startup**: renderer-ready is routed through direct invoke paths, the window waits for first-frame readiness, and startup flashes are reduced.
- **Sidebar and project chrome**: project group badges, hover actions, and Neo badge placement were simplified to avoid overlap and visual noise.
- **Internal maintainability**: collaboration rows, telemetry schema, workspace archive IPC, and Neo Tag tool guards were split out from larger files without changing behavior.

### Fixed

- **Verifier and reviewer infrastructure errors** no longer masquerade as product verification failures; infra failures now degrade explicitly.
- **Transcription rendering** is quieter, with hook cards, failed-state folding, a single thinking block, shimmer behavior, and duration thresholds tuned down.
- **Session/runtime correctness** fixes include persisted working directories across restarts, assistant message metadata round-tripping, terminal assistant persistence checks, export transcript cache wiring, and agent badge routing.
- **Desktop packaging** now stages the `cua-driver` helper outside Spotlight/Launchpad indexing paths.

## [0.23.0] - 2026-07-01

### Added

- **Multimodal bridge — chat providers auto-bridge to the media page** (Spec 1): a chat provider whose model advertises generation capability (`imageGen` / `videoGen` / `musicGen`) is now derived into a usable image/video/music model on the multimodal page, reusing the source provider's `baseUrl` + key (key never leaves the host). Pure-generation models are hidden from the conversation selector. Adds the derivation layer `deriveBridgedVisualModels`, three merged list handlers, an exhaustive key-set guard against `apiKey`/`baseUrl` leaking into bridge entries, and a compat video flavor-poll registry (standard/agnes/openrouter). Bridged image goes through the openai-compat engine; video through a generic openai-compat video engine with flavor polling; music through the MiniMax `music_generation` engine (hex audio decode).
- **Native Veo video provider** (Spec 3): new built-in `google` video provider hitting the Gemini-API light path (`predict` + long-running-operation poll, `x-goog-api-key`, not Vertex), reusing the existing `gemini` key slot. Defaults to `veo-3.1-fast`. Proxy is wired through a dedicated `veoFetch` helper (axios + gemini proxy agent + `maxRedirects: 0` + Google-API allowlist to block SSRF); all guards run before any paid call, with buffer-direct output and a self-guarded download allowlist.
- **Native Seedance video provider** (Spec 2): new built-in `ark` video provider on Volcengine Ark (`submitAndPollArkVideo` → poll to `succeeded` → `content.video_url`), authenticated with a plain Bearer Ark API key that reuses the existing `volcengine` slot (zero new config surface). Seedance is registered into `VIDEO_MODELS` with placeholder pricing pending dogfood calibration.
- **Music generation** (MiniMax): music-generation IPC handler + on-disk output + bridged/built-in `minimax` branch, a shared `resolveMusicModelEndpoint` endpoint resolver, and a `music_generate` built-in agent tool.
- **@Neo tag — work-card collaboration workflow**: mentioning `@neo` drafts a work card and drives a draft → approve → run → result-review loop, with an inline work-card card in chat, a project-collaboration page exposed from the sidebar, and a Neo work-card repository + schema/indexes.

### Fixed

- **Neo runtime safety guard (fail-closed)**: approved Neo Tag runtime runs (scoped by the `neoTag` runtime context) can no longer mutate state through non-file tools. Blocked during Neo runs: direct git/shell mutation (`git_commit` add/commit/push, `git_worktree` add/remove/prune, `kill_shell`), multi-agent/workflow/teammate writes, planning/findings/task/plan-mode mutations, `MemoryWrite` write/delete, `SkillCreate`/`propose_role`, calendar/reminders/mail connector writes, MCP `add_server` and non-read-only tool invocations, and process submit/write/kill. Read-only observation (status/log/diff/list/get) stays allowed. Ordinary non-Neo tool calls keep their existing permission path.
- **Multimodal i2v base-image guard hoisted to a provider-shared gate** (Codex audit round 2–3): the image-to-video base-image validation was previously hardcoded to a single provider's key gate, leaving Seedance `ark` i2v dead-on-arrival on the real IPC path (unit tests passed but the canvas produced nothing). Guard hoisted above provider routing so it covers wanx/minimax/ark uniformly, and Seedance i2v now selects the provider-appropriate key.
- **Control-plane public-key source merge** (release infra): env policy / cloud release policy / OSS direct-connect fallback now resolve public keys from a single merged source.
- **Compat video `create` timeout widened to 120s**: a free-tier compat provider (Agnes) queued the create call ~89s; the engine's 30s submit budget mis-killed it. A compat-specific `createTimeoutMs` avoids the false timeout (the earlier proxy suspicion was actually slow create).

## [0.22.2] - 2026-06-29

### Fixed
- **in-app 软件更新整包下载间歇性失败**：更新检查（Vercel `/api/update?action=check`）返回的 `downloadUrl` 此前指向 GitHub release **网页** 而非安装包直链，客户端 in-app updater 的 `downloadFile()` 抓到 HTML 而非 dmg/exe，导致更新装不上。改为返回 OSS 安装包直链（与原生 Tauri 更新器同源），并由发布管线（`build-stable-release-json.mjs --compute-asset-sha256`）为每个安装包计算 sha256 写入 `release.json`，客户端校验从「缺 sha256 时 override 放行」升级为真校验。
- 经 4 轮独立对抗审计硬化 `(downloadUrl, sha256, version)` 同源不变量：env policy override、cloud release policy、OSS 直连 fallback、`check` 与 `action=download` 两端，全部做到三者同源或 fail-closed；并修复发布脚本对非安装包响应（HTML 错误页/占位）误算 sha256、`normalizeSha256` 对非字符串输入崩溃、auto-download 未捕获 rejection 等健全性问题。

## [0.22.1] - 2026-06-29

### Fixed

- **IME composition guard on popup/search/rename inputs**: pressing Enter to confirm a Chinese (or other IME) candidate was treated as select/submit/close — it closed the model-switcher popup, submitted partial searches (chat search, skill discover), and committed half-composed renames (project / design layer / session title / new file). Added `isComposing` / `keyCode === 229` guards to ModelSwitcher + 7 text inputs (URL/path inputs and non-text `role=button` keydowns left untouched).

## [0.22.0] - 2026-06-29

### Added

- **Design mode is conversational again** (recovered): switching to Design activates a session-bound canvas + opens the canvas tab instead of popping a fullscreen brief form (form demoted to an on-demand entry for web/slides/video). Recovered from `feat/design-conversational-surface` (never merged; production renderer had regressed to the form after the 2026-06-27 hot-update was published from form-only main). Brings per-session design-active flag, canvas injection gate, intent-driven canvas tools, cross-session owner isolation.
- **Generation model defaults** (ADR-027): a "Generation defaults" settings tab to pick default image/video models; design pulls them on launch.
- **Settings IA regroup**: model-related tabs (model / generation / execution engine / search / voice) consolidated into a top "Models & capabilities" group; budget-alert tab entry removed (underlying budget logic kept).
- **Tool-error observability (Sentry) + telemetry session-restore** (ADR-030): handled tool failures of actionable categories report to Sentry (auth-free, allowlist + dedup + scrubbed); session-expired-with-cached-identity surfaces a non-blocking reconnect nudge instead of silently clearing; Keychain session-persistence dead-code fixed.

### Fixed

- **Chat — local HTML links open in-app preview**: model-generated games/pages written as `[file.html](file://...)` open Neo's in-app artifact preview (playable) instead of the system browser.
- **Chat — external/file link clicks work in packaged app**: `openExternalLink` routes through the webServer IPC bridge instead of the Tauri opener plugin, which silently no-op'd in the http-origin webview.
- **Chat — Sources card collapsed by default**: web-fetch provenance card folds by default (expand on click).

## [0.21.1] - 2026-06-27

### Added

- **Sidebar — Codex-style conversation list redesign** (#287): each row reduced to title + relative time; running sessions show a spinner, attention states (error/approval/paused/incomplete) a quiet semantic dot. Eval diagnostics (trajectory quality `G0·Diag`, evidence level `EV`), type/automation badges, the summary line and replay-evidence buttons moved out of the default row (still reachable via project console / replay panel). Replay/assets/archive actions are hover-only. Project group header collapses its console/details/assets/new toolbar to hover; long lists fold to the first 5 sessions with an "expand all" toggle (auto-expands under search or when the current session is past the cap).

### Fixed

- **Keybinding — unbind resend by default** (#290): `Cmd/Ctrl+Shift+R` clashed with the browser/desktop hard-reload shortcut; an accidental press re-sent the last message, which for paid image/video generation meant silently paying again. The `session.retry` action now ships unbound by default (users can rebind it in settings).
- **Design canvas — proposal design-mode gate** (#291): `useCanvasProposalReview` was missing the design-mode gate that `useCanvasVideoRequest` already enforces, so canvas writes could land outside a design context. Mirrors the sibling fail-closed gate (reject + immediate respond so the blocking host tool resolves) without reintroducing per-session ownership complexity.

### Changed

- **Design-system bare-button ratchet** (#289): baseline lowered 772→736 with token-based buttons across NativeDesktopSection / RolesTab / SidebarProjectDrawer.
- Internal refactors: `src/main` → `src/host` directory rename; god-file splits (decision-trace recording, prompt-budget helpers, cron row/schedule normalizers, godfile-host #288); repo cleanup of mistakenly-tracked runtime artifacts; release gate now verifies the updater public key is injected into build artifacts.

## [0.21.0] - 2026-06-27

### Added

- **Design canvas — agent-operated edits**: the design agent can now propose canvas operations (ghost preview + approval UI, ADR-026), with per-op accept/discard, soft-delete + restore of nodes, and design-agent medium tool gating (ProposeVideoOps/ProposeSlidesOps + `designCanvasActive`).
- **Design canvas — bounded autonomy** (ADR-027): set a budget envelope (max variants + max spend), the agent generates N divergent variants within it, you pick the winner; budget gate hard-stops on overrun, with envelope approval UI, progress, lifecycle, and i18n.
- **Design — custom image-gen models + health-aware selection**: register custom image models in Settings; the canvas avoids unconfigured models and falls back on balance/credential failure.
- **Design — video cover + auto-fit + design→code handoff**: video gets an auto cover and viewport auto-fit; large (>2MB) videos play inline via Blob URL; design output can carry code-handoff context with an acceptance/constraint contract.
- **Preview/QA — artifact verification pipeline**: deterministic artifact health check + subjective vision QA layer + automatic repair loop; artifact QA routed through the in-app browser by default; PPT pixel-level per-page screenshot preview.
- **Web search — query planning & evidence ranking**: plan queries before searching, rank primary evidence, mark recency-constraint strength, provider capability health matrix, and configurable search sources (multi-source enable/disable + priority).
- **Agent — collaboration tree**: read-only agent tree snapshot + worktree review surface; unified agent failure codes; success write-storm detection + delivery-review evidence.
- **Telemetry — cost calendar**: daily/weekly/monthly cost aggregation.
- **Unified evidence contract** across file/shell/discovery/browser-computer tools, with hardened read gates and discovery pagination.

### Fixed

- Sidebar session-list flicker on refresh (signature memoization) and startup white-screen flash (`#18181b` window background).
- Security hardening: closed `rm` long-option / arbitrary-order flag bypasses across the dangerous-command defenses.
- Numerous design-mode adversarial-audit fixes (illustration cost ceiling, abort-timer leak, SSRF-via-redirect, filename traversal, region-lock strict defaults).

### Changed

- Internal source tree renamed `src/main` → `src/host` and de-Electron-ized API shims; god-file splits across DesignCanvas, Sidebar, host, telemetry, and workspace IPC. No user-facing behavior change.

## [0.20.0] - 2026-06-22

### Added

- **Design mode — tab reorganized by delivery medium**: Web / Image / Slides / Video, so users pick "I want to make a ___" up front (`DesignOutputType` UI aggregation, zero-breaking).
- **Design mode — thick slides pipeline**: requirement →（optional AI）outline → per-slide editing (title/points/reorder) → pixel preview (LibreOffice real-layout render) →（optional AI illustrations, model chosen on the page）→ real-layout PPTX export with brand-color theming. Engine extracted to `services/design/slidesGenerator` (SlideData[] single source of truth); enhancements are opt-in with cost shown up front.
- **Design mode — reference-image priming**: paste a reference image before generating ("Add reference" entry, sky badge on the canvas); the first reference is fed to the model as visual guidance (Tongyi Wanxiang `wanx2.1-imageedit` / `description_edit`), preserving the reference layout while restyling per the requirement.
- **Design mode — unified history**: design history consolidated into the left composer — image/video step timeline (reference images grouped separately, not counted as versions), and prototype version view/compare/finalize moved from the preview toolbar into the left panel. Image and prototype share the non-destructive variant spine.

### Fixed

- Reference-image path: fails loudly when the reference image can't be read (no silent fallback to text-only generation); reference images don't expose the region-repaint toolbar; continuing-edit clears stale compare state.

## [0.19.1] - 2026-06-22

### Fixed

- Fixed packaged-app startup failure introduced in v0.19.0 ("Web server exited before healthcheck completed: exit status: 1"): the design-mode PDF/PPTX export eagerly loaded `pdfkit`/`pptxgenjs` at startup, but those deps were esbuild-external and not shipped in the app, so the backend web server crashed on launch. Both are now bundled into the backend (`pdfkit` via its font-inlined standalone build). Functionally identical to v0.19.0.

## [0.19.0] - 2026-06-22

### Added

- **Design mode — switchable image models**: text-to-image can switch among Tongyi Wanxiang / CogView-4 / FLUX.2 / **gpt-image-2**, driven by a capability-tagged visual-model registry; the switcher only lists visual-generation models with a configured key (chat models filtered out). gpt-image-2 is wired via a custom OpenAI-compatible endpoint.
- **Design mode — video generation (new)**: text-to-video and image-to-video on the canvas via Tongyi Wanxiang Video and MiniMax Hailuo, as first-class canvas nodes on the non-destructive variant spine, with a prominent per-duration cost estimate before generation.
- **Annotation-redraw editing**: annotate on the canvas (pen/arrow/rect/text), bake the annotations into a screenshot, and have the model redraw a clean revised image — a mask-free edit path for models that don't support mask inpaint (e.g. gpt-image-2).
- **Brand/design-system reuse**: persist your own brand palette, fonts, and component tokens and inject them into subsequent generations for cross-generation consistency.
- **In-place text editing** for interactive prototypes (click text to edit, no regeneration).
- **PDF and PPTX export**.
- **Agent execution-engine compatibility matrix** + a settings section for execution engines; **MiMo-Code and Kimi Code** execution engines integrated.

### Fixed

- SSRF guard on image URL downloads: https public hosts only, rejecting private/loopback/metadata addresses (fixes an IPv6-literal bypass that was dead code).
- Design IPC actions reject blank/out-of-range params before any paid call, avoiding wasted paid requests.
- All new design-canvas IPC capabilities registered in the shell capability manifest so renderer hot-update gates pass.
- Stability batch fixes across execution paths.

## [0.18.0] - 2026-06-21

### Added

- **Design Mode (full)**: a top-level design workspace alongside Code, covering interactive prototypes (HTML), mockups/infographics on an infinite konva canvas (text-to-image + true mask inpaint via Tongyi Wanxiang), and a deterministic design-quality self-review hook. Informed by an OpenDesign/Lovart competitive-borrow study (`docs/competitive/opendesign-lovart-借鉴清单.md`).
- **Variant version spine (T1)**: canvas and prototype share a non-destructive variant model — every operation lands a new pinned variant (never overwrites), discards are soft-deletes, with side-by-side compare and set-as-main.
- **Cost transparency + reversible history (T2)**: pre-generation cost estimate, named/undoable history steps, and BYOK actual-spend visibility (IPC returns `actualModel`/`costCny`).
- **Image expand + watermark removal (T3)**: Wanxiang `expand` (directional ratio outpaint) and `remove_watermark`, landing into the variant spine.
- **Consistency-locked re-editing (T4)**: region-lock + diff-gate keeps the unselected region pixel-identical after inpaint (out-of-bound pixels are pasted back and a diff-evidence image is written).
- **Direction cards + reference-screenshot intake (T5)**: a mandatory pre-generation clarification form with multi-direction cards, a "match a reference screenshot" branch, and a "just generate" escape hatch.
- **Runtime reskin + real-image placeholders (T6)**: prototype preview supports 5 instant theme palettes (no regeneration), and generated prototypes use deterministic real images instead of gray placeholders.

### Fixed

- Registered new design-canvas renderer IPC capabilities (generate/edit/import design image) in the shell capability manifest so renderer hot-update gates pass.
- Family-level path-traversal guard (`assertWithinDesignDir`) across all design IPC actions.
- Multiple adversarial-audit hardening passes on the variant spine, expand/remove, and the consistency gate (symmetric application + boundary fixes).

## [0.17.2] - 2026-06-18

### Added

- **Firecrawl default web data layer**: `WebSearch` and `WebFetch` now prefer Firecrawl for public web search/scrape, with keyless mode, authenticated API key support, native fetch fallback, and local/private/raw URL exclusions.
- **Post-publish release verification**: added `release:post-publish` / `release:neo --post-publish-verify` checks for update metadata, download redirects, landing version slot, renderer rollout, OSS manifests, `release-record.json`, rollback state, and optional Vercel log audit.

### Changed

- Search routing now starts from Firecrawl and adds premium sources by query type; configured but unused premium sources are surfaced as a soft `sources` hint.
- Chat input recommendations are quieter: skill recommendations are capped at two, capability suggestions at three, and duplicate skill/capability chips are filtered.

### Fixed

- Firecrawl keyless rate limits now show a concrete `FIRECRAWL_API_KEY` setup hint, and repeated Firecrawl transport/HTTP failures trigger a short cooldown instead of adding timeout cost to every request.
- Non-streaming OpenAI-compatible and Claude tool-call responses now preserve preamble text and ordered `contentParts`, keeping tool blocks in the same order as streaming responses.
- Models with tool-calling capability no longer get false composer warnings that they cannot handle search tasks.
- Packaged runtime logging now honors `CODE_AGENT_LOG_DIR`, keeping Tauri and Node webServer log paths aligned for diagnostics.

## [0.17.1] - 2026-06-17

### Fixed

- Registered budget settings shell capabilities for renderer hot-update manifests so `getBudgetStatus` and `setBudgetConfig` no longer block release gate verification.

## [0.17.0] - 2026-06-17

### Added

- **Event ledger and recovery**: append-only ledgers now cover permission decisions, tool execution lifecycle, session replay projections, Swarm rollups, crash recovery snapshots, and reconcile diagnostics.
- **Budget alerts**: budget config, runtime budget IPC, StatusBar usage coloring, and threshold / over-limit toast notifications are now wired into the app.
- **Design system gates**: design-system contract docs, baseline checks, hex-color ratchet rules, and Modal primitive migrations start turning UI consistency into enforceable checks.
- **Model, voice, and workflow surfaces**: model strategy visibility, prompt stack summary, configurable hotkeys, end-to-end voice input, session media assets, project/session organization, and capability evidence gates have been added.

### Changed

- Chat, sidebar, composer, route trace chips, and tool result presentation have been decluttered so user-facing state is clearer and engine internals stay out of the main path.
- Swarm ledger read paths can rebuild rollups from the ledger and fail-safe back to existing sources when a projection is incomplete.
- Release and quality gates now include additional console, accessibility, stale-dist, eval, and capability-evidence checks.

### Fixed

- Fixed voice transcription privacy bypasses, hotkey focus gating, shell capability boundaries, budget startup config sync, stale session status semantics, and model/tool-result echo issues.
- Fixed several chat reliability problems around auto-load retries, fake edits, streaming code/diff layout shifts, search-source quota failures, and schema parse-error feedback.
- Fixed renderer polling, duplicate requests, and empty-draft model inheritance behavior.

## [0.16.104] - 2026-06-12

### Added

- **Agent runtime hardening**: MiMoCode 对照后的多级 Edit replacer、doom-loop guard、Task gate、goal impossible 止损、max-step 三段式兜底、retry 分类和 provider 失败友好提示进入主链路。
- **History / memory / dream**: transcript FTS 按 kind 索引工具输入输出、用户文本、assistant 文本和 reasoning；History 工具进入 deferred tools；memory packing 增加 BM25；dream consolidation 以原始轨迹为证据。
- **Experience distillation**: `/distill`、skill executor registry、六阶段 pipeline、LLM 提案生成器和 30 天自动调度落地；生成 skill 仍先入草稿，需用户确认后才安装。
- **Nested subagent and Max Mode**: 子代理可递归委派，整棵 spawn tree 共享深度、配额、超时和 token budget；Max Mode 支持 propose-only best-of-N、judge 选优和 winner replay。
- **MCP / admin ops**: 普通登录用户可自助添加、启停、重连 MCP server；HTTP Streamable MCP、`url` alias 和 headers 进入 `mcp_add_server` / `MCPUnified`；管理员可通过 Supabase RPC 授予或撤销他人 admin。

### Changed

- checkpoint writer 保持后台 LLM 子代理路径，但前台重建边界只短等窗口，超时或无明确成功结果时 fail-closed 回 summary 压缩。
- renderer production verifier 给 control-plane/app update/manifest/release-record metadata 和 renderer bundle hash 下载设置超时，并输出 stage diagnostics，避免发版验收无限等待。
- skill distillation 草稿拒绝 `grep-read-edit`、`bash-bash-bash` 这类低价值工具序列名，防止把机械操作串误沉淀为方法论。

### Fixed

- renderer active bundle 版本低于当前 shell version 时回退 builtin renderer，避免旧前端遮住新壳修复。
- dream 防幻觉门收紧，避免弱证据候选写入长期记忆；无近 7 天会话时不再降级全历史。
- prompt provider variant A/B 结果写入 eval metadata；`PROMPT_VERSION` 回退到真实内容版本，避免无内容 bump 污染归因。
- unsupported weekly cron interval 在主进程拒绝，前端不再展示不可用 weekly interval 选项。
- vision analysis 现在保留最后失败原因，空响应会报告为 `empty_response`，不再被误归为 generic exception。
- `session_tasks.parent_task_id` 进入 runtime recovery state，恢复时保留任务树父子关系。

## [0.16.103] - 2026-06-11

### Added

- **Windows (win32-x64) 测试版首次随版发布**：NSIS unsigned perUser 安装包（无 UAC），release.yml 独立 build-windows job 进正式发版链，三平台 latest.json（darwin-aarch64 / darwin-x86_64 / windows-x86_64）；windows leg 失败自动降级 mac-only 发版。
- 分发页设备感知：按访问者 OS/芯片推荐对应安装包（只决定排序与高亮，所有平台入口保持可见可点）。
- PII 安装链 Node 化（setup-gliner-pii.mjs 双平台一份实现），Windows 包可启用本地 PII 防线。

### Fixed

- Local(Ollama) 假性"已可用"：列表展示前先探测本地服务，未装 Ollama 不再显示本地模型可用。
- 配好 provider 后默认模型自动接管，消除"明明配置了还说没配置"。
- MiMo 托管 key 登录后下发（sharedProviderKeys 控制面到客户端全链路）。
- 更新分发资产选择两处隐患：服务端/客户端均不再可能把 runtime manifest（JSON）当安装包下发；Intel mac OSS 降级路径不再误取 arm64 dmg。
- 权限路径白名单 Windows 语义旁路（path.relative 体系 + NTFS 大小写不敏感）+ 归档解压反斜杠/盘符条目逃逸。
- ConnectorRegistry 平台过滤：非 macOS 不再注册 AppleScript connector 组（11 个工具不进 LLM 工具列表）。

## [0.16.102] - 2026-06-10

### Fixed

- 会话导出（Markdown / 会话日志）打包态静默失败：改主进程直写「下载」文件夹 + 访达定位 + toast 反馈，废弃 webview 另存为对话框链路。
- conversationRuntime 测试 mock 补 PROMPT_VERSION 导出（16 用例恢复）。

## [0.16.101] - 2026-06-10

### Added

- **Intel Mac (x64) 双架构首发**：发版矩阵 arm64 + x64（macos-15-intel 原生构建），单 manifest 双平台键（darwin-aarch64 + darwin-x86_64），分发页按芯片选包，`/api/update` 按 arch 路由。x64 限制：VAD 不适配（onnxruntime-node 无 darwin-x64），静默降级。
- Computer Use 新底座（CUA，默认关闭）：cua-driver 重签为「Agent Neo Computer Use.app」，stdio MCP 接入，权限 UI（Accessibility 必需 + 一键授权），重签产物走 OSS 预构建分发（sha256 锁定）。
- 会话右键「导出会话日志」：脱敏诊断包 + 当天日志尾部，未登录可导；会话导出改原生「另存为」对话框。

### Fixed

- 中转站「测试连接成功但会话 404」：baseUrl 末尾斜杠解析层统一 trim；404 错误带实际请求 URL + /v1 提示；aiSdk 路径 HTTP≥400 落带 URL 日志。
- 工具结果落库前 eager 压缩导致模型重试循环：observation 原样可见，L1 投影层跨轮幂等重截断。
- WKWebView 启动连刷：启动 URL 唯一 `?boot=` 参数 + index.html `Cache-Control: no-store`。
- 视觉分析智能候选路由；默认视觉模型对齐默认 provider；MCP 认证失败路由到重新授权。

## [0.16.100] - 2026-06-09

### Added

- 经验沉淀重做（ADR-020）：废弃 telemetry n-gram 频次蒸馏，skill 自动沉淀统一收口到 LLM 语义复盘（Hermes/Anthropic 规格），入口闸 + 反思门 + 命名禁用清单 + 结构化 SKILL.md。
- Telemetry 可诊断性：trace/session 版本指纹（agentVersion/promptVersion/toolSchemaVersion），本地全量诊断旁表 + 失败 session 脱敏诊断包上报，Langfuse 默认开启 + opt-out 开关。

### Changed

- 删除/卸载操作直接调用工具，确认交给权限卡片；命令安全分级松绑误杀（目标明确单路径删除从硬毙降为一次确认，删根/家/通配仍硬毙）。

### Fixed

- 解除挂起权限请求死锁：新消息/取消时 resolve 挂起请求，不再冻结到 60 秒超时。
- 强化 provider 选择与诊断；截图发非视觉模型不再丢图；云端同步会话改幂等 upsert 修 NULL-owner 主键冲突刷屏；sseStream 响应头首字节超时修 accept-then-hang；skill 名称容错 + did-you-mean。
- LogMasker 超大输入预截断，修复脱敏 ~110s 卡顿。

## [0.16.99] - 2026-06-08

### Fixed

- 修复 notarized app 在慢启动环境下可能因 webServer 初始化超过 30 秒而被 Tauri healthcheck 杀掉的问题；启动等待窗口调整到 90 秒，覆盖 Supabase session timeout、旧库迁移和首次插件初始化的组合耗时。

## [0.16.98] - 2026-06-08

### Fixed

- 修复 Claude 连接测试仍使用废弃 `claude-3-haiku-20240307` 的问题，改为优先使用当前选择模型，并在缺省时使用 provider 当前默认模型。
- 修复 AI SDK 流式工具调用可能被终态空 `tool-call.input` 覆盖已累积参数的问题，避免 Write 等工具在执行层收到空参数。
- 修复默认 provider 未配置但其他 provider 已配置时仍放行发送的问题，避免 Claude 配好后默认配置残留到 MiMo 造成 `Invalid API Key`。
- 增强模型决策与工具参数校验失败的本地 replay 和低敏远端上报，便于定位实际 provider/model、路由原因和 `tool_args_validation` 失败。

### CI

- PR 阶段左移 renderer bundle capability 校验，提前暴露热更新 manifest 能力差异。

### Added

- 🎯 **Goal Mode（`/goal` 自治目标循环）**：用户给目标 + 完成条件，Agent 自己反复跑、每轮自判、达成才停。完成判定权落在**代码层**（模型只能"申请退出"），三层闸：闸1 确定性 `--verify` 命令退出码（`/bin/sh -c` 直接 exec，不经 LLM）、闸2 可选 `--review` 软条件（派强模型 Reviewer 子代理判 PASS/FAIL）、闸3 代码层兜底（token 预算 / max-turns / 连续无进展）。`--verify` 与 `--review` 二选一即可（支持纯软目标）。详见 [docs/designs/goal-mode.md](docs/designs/goal-mode.md)。
- 🎯 `/goal` 斜杠命令 UI：触发卡片 + ChatInput 上方实时状态条（轮次 / 预算 / 计时）+ 生命周期完成卡片；走桌面 IPC + headless REST 两条链路。新增 `attempt_completion` 工具（仅 goal-mode 暴露）+ Codex 式审计 nudge（每 checkpoint 注入"先假设没做完、逐项找证据"自检）。
- 📸 **Appshots（左右 Command 双击截窗）**：macOS `CGEventTap` listen-only 监听左+右 Command，捕获当前前台 app 窗口截图（`screencapture -l`）+ AX 无障碍树文本（OCR 兜底），以隐藏 `<appshot>` XML + 图片附件注入聊天上下文，输入框展示可预览 chip。详见 [docs/designs/appshots.md](docs/designs/appshots.md)。仅 macOS。
- 🔒 **bypassPermissions 档接入 OS 级沙箱**：YOLO 权限档的 bash 执行用 macOS `sandbox-exec` / Linux `bwrap` 包装（命令前缀注入，复用前台执行器保住流式 / 中断 / 错误语义）；沙箱不可用时 **fail-fast 硬报错拒绝执行**，绝不静默裸跑。新增 `wrapCommand` 命令包装 API，由 `SANDBOX.OS_SANDBOX_ENABLED` flag 门控，其余权限档行为零变化。
- 📎 **附件管线 v2（多类型附件 → 端侧摘要 → 模型上下文）**：补齐 `audio` / `video` / `presentation`(PPTX) / `archive`(ZIP) 四类附件。上传时在端侧用 `jszip` 解 PPTX 逐页提文字/图/表（≤20 页）、解 ZIP 出目录清单（≤200 条 + zip-slip 危险路径检测），**不自动解压**；重二进制本体既不喂模型也不写库，持久化只留轻量摘要（`pptJson` / `archiveManifest`）。`<attachment>` 内联块沿用 Appshots 的"对用户隐藏、对模型可见"模式（`stripInlineAttachmentBlocks`），desktop + web 双链路在持久化边界统一 strip/sanitize。详见 [docs/designs/attachments.md](docs/designs/attachments.md)。🚧 来自验收迭代，未经逐行 review，待后续处理。

### Changed

- 🔌 **Provider 层迁移到 Vercel AI SDK（双引擎）**：新增 `aiSdkAdapter`，实现现有 `ModelRouter.inference` 契约，把 provider 原生响应归一成统一 `tool-call` / `tool-result`（流式 `streamText` + 非流式 `generateText` 同源）。子代理与主 loop 默认走 AI SDK，`CODE_AGENT_MODEL_ENGINE=legacy` 一键全回退；gemini 等非 OpenAI 兼容 provider 自动留旧路径。`providerResolution.ts` 收口 baseURL/apiKey 解析为单一来源。从根上消灭"两套解析不对称"的整类 bug（DeepSeek 非流式 DSML 漏 tool call 等）。

### Fixed

- 修 AI SDK 主 loop regression：`toAiMessages` 漏带消息重排（夹层 system 消息导致 `MissingToolResultsError`），补 `reorderToolResultsAfterAssistant` 镜像旧路径 `sanitizeToolCallOrder`。
- 修 `agent_complete` SSE 终态双发（runFinalizer + route 兜底各发一次）→ `emitAgentEvent` 对终态幂等。
- 补 AI SDK 适配器丢失的 per-request / 流式超时契约（request-timeout / first-byte / inactivity 看门狗）+ 子代理 idle 看门狗死配置。
- `postinstall` 恢复 node-pty `spawn-helper` 执行位（资源扫描 EACCES / PTY 起不来）。

## [0.16.75] - 2026-05-18

### Added

- 🍎 首个经 Apple Developer ID 签名 + Apple Notarization 的 macOS release：下载 dmg 双击即装，Gatekeeper 直接放行，零警告。
- `scripts/tauri-release-bundle.sh`：自动递归签 14 个 nested Mach-O 二进制（sharp / keytar / better-sqlite3 / onnxruntime / node-pty 等 third-party native modules）。
- `scripts/tauri-release-bundle.sh`：build 完成后自动用 `hdiutil` 重建 dmg + 重签。
- `scripts/publish-release.sh`：一键 release 发布流程。

### Changed

- `src-tauri/tauri.conf.json` `bundle.resources`：收紧 `onnxruntime-node` 和 `node-pty` 的 glob，剔除 win32 / linux / darwin-x64 跨平台 prebuilds，dmg 体积从 147 MB → 51 MB（-65%）。

### Fixed

- nested third-party native modules 未签导致 notarytool 拒收。
- `TAURI_SIGNING_PRIVATE_KEY` 必须是私钥内容（之前误设 `_PATH` 导致 `cargo tauri build` 中断）。

---

### Added (Unreleased — 后续发布)

#### 2026-04-26 Productization Pass

- Chat-Native Workbench B+ IA: ChatInput `+` menu, model+effort capsule, Settings “Conversation” tab, Sidebar User Menu, and slimmer TitleBar.
- Live Preview V2-A/B: devServerManager / DevServerLauncher, bridge protocol 0.3.0, TweakPanel, `applyTweak` IPC, and Vite-only MVP scope.
- Browser / Computer Workbench productionization: managed BrowserSession/Profile/AccountState/Artifact/Lease/Proxy/TargetRef, browser task benchmark, and background AX / CGEvent smoke paths.
- Activity Providers: provider-neutral ActivityProvider / ActivityContext contracts for OpenChronicle, Tauri Native Desktop, audio, and screenshot analysis.
- Semantic Tool UI: `_meta.shortDescription` schema/parser path, fallback shortDescription generator, target context icons, memory citation group, session diff summary, and raw URL preview chips.

#### Security Module (Session A: A1-A5)
- **Command Monitor** (`src/host/security/commandMonitor.ts`)
  - Pre-execution validation for shell commands
  - Configurable blocked/warning patterns
  - Post-execution auditing

- **Sensitive Information Detector** (`src/host/security/sensitiveDetector.ts`)
  - Detection of 20+ sensitive patterns
  - API keys, AWS secrets, GitHub tokens, private keys
  - Password and database URL detection

- **Audit Logger** (`src/host/security/auditLogger.ts`)
  - JSONL audit log files at `~/.code-agent/audit/`
  - Tool execution recording with duration and status
  - Query support by time range, session, tool name

- **Log Masker** (`src/host/security/logMasker.ts`)
  - Automatic masking of sensitive information in logs
  - Configurable masking patterns

#### Tool Enhancements (Session B: B1-B6)
- **File Read Tracker** (`src/host/tools/fileReadTracker.ts`)
  - Tracks file read operations
  - Enforces read-before-edit pattern
  - Records read timestamps and mtimes

- **Quote Normalizer** (`src/host/tools/utils/quoteNormalizer.ts`)
  - Converts smart/curly quotes to straight quotes
  - Enables fuzzy string matching
  - Improves edit_file reliability

- **External Modification Detector** (`src/host/tools/utils/externalModificationDetector.ts`)
  - Detects files modified outside Code Agent
  - Warns before overwriting external changes

- **Background Task Persistence** (`src/host/tools/backgroundTaskPersistence.ts`)
  - Persists running background tasks
  - Recovery after application restart

- **Enhanced Grep Parameters**
  - `-A`/`-B`/`-C` context line support
  - `--type` file type filtering

#### Prompt Enhancements (Session C: C1-C4, C8)
- **Injection Defense Rules** (`src/host/generation/prompts/rules/injection/`)
  - Core instruction source verification
  - Response verification guidelines
  - Meta-level rule protection

- **Detailed Tool Descriptions**
  - Bash tool: parameters, examples, anti-patterns
  - Edit tool: error handling, best practices
  - Task tool: subagent types, use cases

#### Hooks System (Session C: C9-C14)
- **Hook Configuration Parser** (`src/host/hooks/configParser.ts`)
  - Parse `.claude/settings.json` hooks configuration
  - Validation and error reporting

- **Script Executor** (`src/host/hooks/scriptExecutor.ts`)
  - Execute external shell scripts
  - Environment variable injection
  - Timeout handling

- **11 Event Types** (`src/host/hooks/events.ts`)
  - PreToolUse, PostToolUse, PostToolUseFailure
  - UserPromptSubmit, Stop, SubagentStop
  - PreCompact, Setup, SessionStart, SessionEnd, Notification

- **Multi-Source Hook Merging** (`src/host/hooks/merger.ts`)
  - Merge global and project-level hooks
  - Priority handling and deduplication

- **Prompt-Based Hooks** (`src/host/hooks/promptHook.ts`)
  - AI-powered hook evaluation
  - Dynamic prompt support

#### Testing Infrastructure (Session D: D1-D5)
- **Integration Test Framework** (`tests/integration/`)
  - Test environment setup utilities
  - Mock services for Electron, database, auth
  - Example tests demonstrating framework usage

- **Test Scaffolds**
  - Security module unit tests (91 tests)
  - Tool enhancement unit tests (57 tests)
  - Prompt builder tests (56 tests)
  - E2E security scenario tests (29 tests)

### Changed

- Live Preview V2-C Next.js App Router support is deferred; V2 scope is now Vite-only MVP.
- Evaluation `max_tool_calls` assertions are weighted process-quality signals instead of critical failure gates.
- Thinking-mode providers send `reasoning_content` consistently for assistant history, scoped through provider overrides.
- **edit_file**: Now requires file to be read first (read-before-edit)
- **edit_file**: Smart quote normalization for better string matching
- **edit_file**: Warning on external file modification
- **grep**: New `-A`, `-B`, `-C`, `--type` parameters

### Deprecated

- None

### Removed

- None

### Fixed

- None yet

### Security

- Added runtime command monitoring
- Added sensitive information detection and masking
- Added comprehensive audit logging
- Added injection defense rules to system prompts

---

## [0.9.1] - 2026-01-22

### Changed
- Version bump

---

## [0.9.0] - 2026-01-XX

> **Note**: This version is in development. See [Unreleased] for upcoming changes.

---

## [0.8.x] - Previous Releases

See git history for previous release notes.
