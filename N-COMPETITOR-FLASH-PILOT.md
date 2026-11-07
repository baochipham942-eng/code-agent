# N-COMPETITOR-FLASH-PILOT — 竞品窗口采集证据档

单号：N-COMPETITOR-FLASH-PILOT｜轮次：第 1 轮（此前 `~/work/evidence/N-COMPETITOR-FLASH-PILOT.md` 不存在，本轮为首轮新建）
采集执行时间：2026-11-06（UTC 口径下窗口为 2026-10-26T00:00:00Z ～ 2026-11-02T23:59:59Z，含两端）
工作树：`~/work/wt/N-COMPETITOR-FLASH-PILOT`，分支 `mq/competitor-flash-pilot`，HEAD `64ba8ef30a710f36214959b5b6ff8dfbcccad561`（短 sha `64ba8ef3`）。本单为只读采集：未改任何仓库文件、未 commit、未 push、未开 PR，工作树 `git status` 干净。
盲测声明：本轮**未读取** `~/work/competitor-archive/` 与 `~/work/code-agent-private-archive/docs/competitive/` 下任何内容，未用其产物交叉核对。
原始抓取件留存：`~/work/out/N-COMPETITOR-FLASH-PILOT/`（claude-code CHANGELOG 全文快照、claude-code releases 日期表、learn.chatgpt.com whats-new HTML 快照）。

---

## 0. 联网工具使用情况

### 实际用到的（全部走通）

| 工具 | 用途 |
|---|---|
| `gh` CLI（GitHub REST API，已认证账号，配额 5000） | felinics/Memoh 与 anthropics/claude-code 的 releases、tags、commits、merge PR 检索、release 正文；claude-code release 发布时间 |
| `curl` → raw.githubusercontent.com | 抓 anthropics/claude-code `main` 分支 CHANGELOG.md 全文 |
| `npm view @anthropic-ai/claude-code time --json`（npm registry） | claude-code 各版本 npm 发布时间戳（与 GitHub release 时间互校） |
| ZCode 内置 webReader（URL→markdown） | `learn.chatgpt.com/docs/whats-new`、`/docs/dots`、`/docs/changelog`（页面为 1MB+ 的 Astro HTML，专用转换器才稳定出全文） |
| ZCode WebFetch | `support.claude.com/en/articles/12138966-release-notes`（成功，拿到全部带日期条目） |
| `curl` 状态探测 | 各源 HTTP 状态码探测 |

### 失败 / 受限的（带报错）

| 工具/目标 | 报错或现象 | 处置 |
|---|---|---|
| `curl https://api.github.com/...`（匿名） | `403 {"message":"API rate limit exceeded for 23.237.50.36. ...","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"}` | 弃用匿名 API，改用已认证 `gh`（配额充足） |
| ZCode WebFetch → `learn.chatgpt.com/docs/whats-new` | `Tool execution timed out after 60000ms` | 改用 webReader，成功取全文 |
| `help.openai.com` | HTTP `403`（任务书预期如此，如实记录） | 未取得该站内容；dots 相关信息全部来自 learn.chatgpt.com 一手文档 |
| Memoh 仓库 changelog 文件 | root 目录无 `CHANGELOG.md`；`docs/CHANGELOG.md`、`docs/changelog.md`、`RELEASES.md` 均 404 | changelog 以 GitHub Release notes（按 conventional commit 生成）为真源 |
| Memoh `v1.0.0` 的 GitHub Release | `GET /releases/tags/v1.0.0` → `404 Not Found`；tag 本身存在，指向 2026-11-01T22:48:34Z 的 commit `9a4f1b92` | 判定 v1.0.0 只打了 tag 没发 release 页，1.0 正式发布以 v1.0.1 计 |
| claude-code `v2.1.315` | npm registry 有该版本（2026-10-30T21:05:24Z），但 GitHub releases 无 tag、CHANGELOG.md 无对应章节 | 该版本无任何公开变更说明，列入「拿不到/无法核实」 |
| ZCode WebSearch | 本轮未调用（一手源已覆盖三家全部已知出口，无需搜索旁证） | — |

---

## 1. Memoh（github.com/felinics/Memoh）

### 版本核实（任务书背景项）

窗口前最后已知版本文为 0.x（窗口前最后一个 stable 是 **v0.22.0，2026-10-19**）。窗口内发布序列，逐条核自 GitHub API：

- **v1.0.0-beta.1**（prerelease）— 发布 2026-10-27T02:09:07Z，即 1.0 时代的第一个包。
- **v1.0.0** — tag 存在，打在 commit `9a4f1b92`（2026-11-01T22:48:34Z），**无 GitHub Release 页**（API 404）。
- **v1.0.1**（stable）— 发布 2026-11-01T23:25:44Z，release commit `release: v1.0.1`（`0b28f47`，2026-11-01T23:08:38Z）。

结论：**确如任务书背景所述跳到了 1.0**；对外可安装的 1.0 正式版是 v1.0.1（2026-11-01）。

### 采集口径（判断记录）

- 仓库无 CHANGELOG.md，逐条变化取自两个窗口内 Release 的 notes（v1.0.1 为 v0.22.0 以来的累计口径；对 v1.0.0-beta.1 求差集得到 v1.0.1 独有条目）。
- 表内 `日期` = **用户拿到该变化的发布日**（v1.0.0-beta.1 = 2026-10-27，v1.0.1 = 2026-11-01，UTC）；合入日与发布日有显著间隔（如 10-25 及更早合入、10-27 随版发出）的条目在「变化」列尾以（合入 MM-DD）标注。每条出处链接为对应 Release 页（逐条原文见页内 notes，且每条自带 PR 链接可回溯）。
- 窗口内合入 PR 共 26 个；其中 #1727 在 v1.0.1 之后合入（11-02），未随版本发布，单列一行；#1717（refactor）未进 release notes 但改变 ACP 外部 Agent 的进程模型，判断为用户可见，单列；#1722（chore：升级外部 Agent 协议基线并删除协议快照/录制数据）判为内部改动，不列。
- #1640「清零 Web 类型检查存量错误并改为 CI 硬门禁」本质是内部质量项，但 changelog 自己把它列在 Bug Fixes 下，按规则收录并标注。

### 变化表（64 条）

出处列约定：`R-b1` = https://github.com/felinics/Memoh/releases/tag/v1.0.0-beta.1 ；`R-101` = https://github.com/felinics/Memoh/releases/tag/v1.0.1 ；`PR#n` = https://github.com/felinics/Memoh/pull/n 。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-10-27 | v1.0.0-beta.1 | 外观设置可隐藏侧边栏示例入口 | R-b1 | 支持在外观设置中隐藏侧边栏示例入口 |
| 2026-10-27 | v1.0.0-beta.1 | 模型配置升级迁移到 v2 结构（twilight v0.9.0） | R-b1 | 升级 twilight v0.9.0 并将模型配置迁移到 v2 结构 |
| 2026-10-27 | v1.0.0-beta.1 | 服务商页面拆分为「订阅」与其他 LLM 服务商 | R-b1 | 服务商页面分为订阅与其他 LLM 服务商 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：一次压缩事件折叠全部可折叠内容，run 内在步骤边界原位续跑 | R-b1 | 一次压缩事件折叠全部可折叠内容，run 内在步骤边界原位续跑 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：一轮之内请求只追加，工具结果产生时一次性截断 | R-b1 | 一轮之内的请求只追加，工具结果在产生时一次性截断 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：Retry、edit 与 native Discuss 接入 run 内压缩 | R-b1 | Retry、edit 与 native Discuss 接入 run 内压缩 |
| 2026-10-27 | v1.0.0-beta.1 | 聊天：通过 Markdown 引用发布图片和文件 | R-b1 | 通过 Markdown 引用发布图片和文件 |
| 2026-10-27 | v1.0.0-beta.1 | 新手示例目录加入 cloud-PC 用例 | R-b1 | Add cloud-PC use cases to the starter catalog |
| 2026-10-27 | v1.0.0-beta.1 | 接 Claude Code：斜杠菜单列出其已安装 skill | R-b1 | 斜杠菜单列出 Claude Code 已安装的 skill |
| 2026-10-27 | v1.0.0-beta.1 | 压缩：run 内折叠在上一个请求末尾请求摘要，复用 provider 前缀缓存 | R-b1 | Run 内折叠在 run 的上一个请求末尾请求摘要，复用 provider 的前缀缓存 |
| 2026-10-27 | v1.0.0-beta.1 | 历史 API：get_messages 可按 ref 分页读回本会话原始工具结果 | R-b1 | Get_messages 可按 ref 分页读回当前会话的原始工具结果 |
| 2026-10-27 | v1.0.0-beta.1 | 服务端可管理 models.dev 目录与模型导入 | R-b1 | 服务端管理 models.dev 目录与模型导入 |
| 2026-10-27 | v1.0.0-beta.1 | 搜索：SearXNG 支持自定义请求头 | R-b1 | Support SearXNG custom headers |
| 2026-10-27 | v1.0.0-beta.1 | Web 支持手机端添加到主屏幕（PWA manifest 与图标） | R-b1 | 支持手机端添加到主屏幕(PWA manifest 与图标) |
| 2026-10-27 | v1.0.0-beta.1 | 删除 Bot 需输入 Bot URL 确认（合入 10-25） | R-b1 | 删除 Bot 需输入 Bot URL 确认 |
| 2026-10-27 | v1.0.0-beta.1 | 恢复 /data/skills/<name> 作为用户技能位置 | R-b1 | 恢复 /data/skills/<name> 作为用户技能位置 |
| 2026-10-27 | v1.0.0-beta.1 | Web 类型检查存量错误清零并改为 CI 硬门禁（内部质量项，changelog 自列） | R-b1 | 清零 Web 类型检查存量错误并改为 CI 硬门禁 |
| 2026-10-27 | v1.0.0-beta.1 | 切换 Bot 不再中止原 Bot 进行中的任务 | R-b1 | 切换 Bot 时不再中止原 Bot 正在进行的任务 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：决策续跑前先绑定 retry/edit 历史 | R-b1 | Bind retry and edit history before decision continuation |
| 2026-10-27 | v1.0.0-beta.1 | Agent：修复 ACP 通知队列溢出导致断连 | R-b1 | 修复 ACP 通知队列溢出导致断连 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：执行位置提示只在切换 Computer 时出现，不再改写已发送前缀 | R-b1 | 执行位置提示只在切换 Computer 时出现，下一轮不再改写已发送的前缀 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：spawn_agent 描述不再内嵌模型列表，可用的交给 list_models | R-b1 | Spawn_agent 描述不再内嵌模型列表，可用模型交给 list_models 查询 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：修复外部 Agent 工具结果显示为空 | R-b1 | 修复外部 Agent 工具结果显示为空 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：会话历史与压缩候选不再按 24 小时截断（合入 10-25） | R-b1 | 会话历史和压缩候选不再按 24 小时截断 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：清理失败回复前保留重试历史边界（合入 10-25） | R-b1 | 在清理失败回复前保留重试历史边界 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：压缩因额度耗尽失败时报额度而非上下文超限 | R-b1 | 压缩因额度耗尽失败时报告额度，而不是上下文超限 |
| 2026-10-27 | v1.0.0-beta.1 | Agent：定时任务输入按发送时的样子存储 | R-b1 | 定时任务的输入按发送时的样子存储 |
| 2026-10-27 | v1.0.0-beta.1 | Bot 工作区：名额空出立即接上等待的工作，拆除「可用独立名额」 | R-b1 | 名额空出时立即接上等待的工作，拆除可用独立名额 |
| 2026-10-27 | v1.0.0-beta.1 | 飞书渠道：附件按文件下载读取，JSON 内容文件不再当错误响应 | R-b1 | 飞书附件按文件下载读取，JSON 内容的文件不再被当作错误响应 |
| 2026-10-27 | v1.0.0-beta.1 | 压缩：已被后续历史关闭的 ask_user 调用不再阻塞压缩 | R-b1 | 已被后续历史关闭的 ask_user 调用不再阻塞压缩 |
| 2026-10-27 | v1.0.0-beta.1 | 压缩：移除独立清空压缩日志入口 | R-b1 | Remove manual compaction log deletion |
| 2026-10-27 | v1.0.0-beta.1 | 修补 eMudhra 信任链与含漏洞依赖 | R-b1 | Patch eMudhra trust and vulnerable dependencies |
| 2026-10-27 | v1.0.0-beta.1 | 桌面端：Windows 恢复缩放快捷键 | R-b1 | Restore zoom shortcuts on Windows |
| 2026-10-27 | v1.0.0-beta.1 | 显示：修复剪贴板手势、输入法取消与失效准备锁 | R-b1 | 修复剪贴板手势、输入法取消和失效准备锁 |
| 2026-10-27 | v1.0.0-beta.1 | 错误码：provider 额度耗尽改返回 payment required（合入 10-25） | R-b1 | Return payment required for exhausted provider quota |
| 2026-10-27 | v1.0.0-beta.1 | 文件下载名按 RFC 6266 编码 | R-b1 | 按 RFC 6266 编码下载文件名 |
| 2026-10-27 | v1.0.0-beta.1 | Provider：修正订阅渠道模型上限，允许 Codex 参与自动压缩 | R-b1 | 修正订阅渠道的模型上限并允许 Codex 参与自动压缩 |
| 2026-10-27 | v1.0.0-beta.1 | Skills：不把兼作命名空间的目录当单个 Skill 删除/改名 | R-b1 | 不把兼作命名空间的目录当作单个 Skill 删除或改名 |
| 2026-10-27 | v1.0.0-beta.1 | Telegram：话题群按话题分会话并把消息投回原话题 | R-b1 | 话题群按话题区分会话并把消息投递回原话题 |
| 2026-10-27 | v1.0.0-beta.1 | Web：单个 $ 不再当公式，引导模型用 \(...\)/\[...\] | R-b1 | 聊天中单个 $ 不再当作公式，并引导模型用 \(...\) / \[...\] 写公式 |
| 2026-10-27 | v1.0.0-beta.1 | Web：排队消息的输入框操作统一 | R-b1 | Unify composer actions for queued messages |
| 2026-10-27 | v1.0.0-beta.1 | Web：连接电脑命令按系统切换，Windows 改用 cmd | R-b1 | 连接电脑命令按系统切换，Windows 改用 cmd 执行 |
| 2026-10-27 | v1.0.0-beta.1 | Web：移动端键盘避让完全交给浏览器 | R-b1 | 移动端键盘避让完全交给浏览器 |
| 2026-10-27 | v1.0.0-beta.1 | Web：保留已完成会话的媒体发布结果 | R-b1 | 保留已完成会话的媒体发布结果 |
| 2026-10-27 | v1.0.0-beta.1 | Web：终端/浏览器标签号清零后重新计数（合入 10-25） | R-b1 | Restart terminal/browser tab numbers once none are open |
| 2026-11-01 | v1.0.1 | 回访账号打开或登录时不再等待网络 | R-101 | 回访账号打开或登录时不再等待网络 |
| 2026-11-01 | v1.0.1 | 对话输入框首帧即出现，位置从首帧起确定 | R-101 | 对话输入框首帧出现，位置从首帧起确定 |
| 2026-11-01 | v1.0.1 | 新增会话未读状态与系统通知 | R-101 | 会话未读状态与系统通知 |
| 2026-11-01 | v1.0.1 | 压缩：以 history checkpoint 取代压缩覆盖层 | R-101 | 以 history checkpoint 取代压缩覆盖层 |
| 2026-11-01 | v1.0.1 | 搜索：新增 DeepSeek 搜索 provider（合入 10-30） | R-101 | 新增 DeepSeek 搜索 provider |
| 2026-11-01 | v1.0.1 | 桌面端自动更新失败后自动恢复并持续拾取新版本（合入 10-29） | R-101 | 桌面端自动更新失败后自动恢复并持续拾取新版本 |
| 2026-11-01 | v1.0.1 | 深色主题首帧不再闪浅色 | R-101 | 深色主题首帧不再闪浅色 |
| 2026-11-01 | v1.0.1 | Agent：Codex/Grok 账号登录只在(sic)工作区完成，Memoh 不再解析或保存登录凭据（合入 10-31） | R-101 | Codex、Grok 账号登录只在工作区里完成，Memoh 不再解析或保存登录凭据 |
| 2026-11-01 | v1.0.1 | Agent：run 内折叠把读路径补写的工具结果随调用一起移除 | R-101 | Run 内折叠把读路径补写的工具结果随调用一起移除 |
| 2026-11-01 | v1.0.1 | Agent：修复停机续跑初始化失败与重复回复 | R-101 | 修复停机续跑初始化失败与重复回复 |
| 2026-11-01 | v1.0.1 | Agent：超大 session 准备上下文时每条历史消息只转换一次 | R-101 | 超大 session 准备上下文时每条历史消息只转换一次 |
| 2026-11-01 | v1.0.1 | Agent：重启后接管等待中的问题并正确处理过期回答 | R-101 | Preserve pending decisions across memory backend restarts |
| 2026-11-01 | v1.0.1 | 策略：查询 bot owner 不再加载运行检查摘要（合入 10-30） | R-101 | 查询 bot owner 时不再加载运行检查摘要 |
| 2026-11-01 | v1.0.1 | Telegram：流式限速按 bot 计算，不同 bot 不再互相等待（合入 10-30） | R-101 | 流式限速按 bot 计算，不同 bot 不再互相等待 |
| 2026-11-01 | v1.0.1 | 时间线：冷会话回放每页只算本页，不再逐页重算整个会话 | R-101 | 冷会话回放每页只算本页，不再逐页重算整个会话 |
| 2026-11-01 | v1.0.1 | Web：未启用的外部 Agent 不再误报已不存在（合入 10-31） | R-101 | 未启用的外部 Agent 不再误报已不存在 |
| 2026-11-01 | v1.0.1 | Web：去掉 Google Fonts 外链，首屏不再被阻塞 | R-101 | 去掉 Google Fonts 外链，首屏不再被它阻塞 |
| 2026-10-31 | v1.0.1 | Agent：外部 Agent 统一进程管理并整体简化，ACP 改为每个 Agent 一个共享进程（refactor；未进 release notes，判为用户可见） | PR#1717 | refactor(agent): 外部 Agent 统一进程管理并整体简化，ACP 改为每个 Agent 一个共享进程 |
| 2026-11-02 | 未随版本发布 | Web：onboarding 主按钮长文案折行，换字改用 LabelSwap 平滑变宽（v1.0.1 之后合入，截至采集时无发布版本包含） | PR#1727 | fix: onboarding 主按钮长文案折行，换字改用 LabelSwap 平滑变宽 |

---

## 2. OpenAI dots（闭源产品，learn.chatgpt.com 一手文档）

### 采集口径（判断记录）

- dots 无独立版本号；任务书给的两个一手页 `learn.chatgpt.com/docs/dots`（产品文档）与 `/docs/whats-new`（周报 digest，**条目本身不带日期**）都已抓全文。whats-new 页首句明确「every versioned update, bug fix, and minor improvement」见 **ChatGPT & Codex changelog**（`learn.chatgpt.com/docs/changelog`），该页条目自带日期，是本轮 dots 侧日期的唯一一手来源。
- 能对上 changelog 日期的条目给日期；dots 文档里给不出日期的表述一律标「日期不明」，不猜。
- dots 依托 ChatGPT/Codex 面板运行，其窗口内平台级变化（iOS 应用、Codex CLI、Work/Codex 模型）一并逐条收录；Codex CLI notes 的 Chores 段（构建链/打包）判为内部改动不逐条列。
- `help.openai.com` 403（见第 0 节）。

### 2.1 窗口内带日期条目（来自 ChatGPT & Codex changelog）

出处列约定：`CL` = https://learn.chatgpt.com/docs/changelog 。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-10-26 | （平台）GPT-6.1 Terra | GPT-6.1 Terra 上线 ChatGPT Work 与 Codex（Plus/Pro/Business/Enterprise/Edu）；强图像理解+精确 computer use；桌面 App「Advanced」与 Work 网页模型列表可选，Work 移动端也支持；不进 Chat、不支持 UAE 推理驻留 | CL | GPT-6.1 Terra is now available in ChatGPT Work and Codex on Plus, Pro, Business, Enterprise, and Edu plans |
| 2026-10-26 | （dots 文档同步） | dots 文档：dots 前沿模型家族纳入 GPT-6.1 Terra（与上条同源发布） | https://learn.chatgpt.com/docs/dots | We're expanding the family of frontier models that power dots to include GPT-6.1 Terra |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 响应内可直接播放音频/视频 | CL | Play audio and video directly in responses |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 任务动态里点子代理名字可打开其会话 | CL | Tap a sub-agent's name in task activity to open its conversation |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 重开任务或重启应用时恢复草稿附件与批注 | CL | Draft attachments and annotations are now restored when you reopen a task or restart the app |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 引用补全支持含空格的聊天/技能名；插件技能名更易读 | CL | Reference autocomplete supports chat and skill names containing spaces |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 同模型下 Plan 模式保留所选 reasoning effort | CL | Plan mode preserves your selected reasoning effort when using the same model |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 加载旧工作超时后已加载内容保持可见，可重试 | CL | Loaded activity stays visible if loading older work times out, with an option to retry |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 队列加载失败提供 Retry | CL | Queue-loading failures now offer a Retry action |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 改进 Windows 文件链接与 Markdown 图片支持 | CL | Improved support for Windows file links and Markdown images |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 修复 Linux 主机上 worktree 创建 | CL | Fixed worktree creation on Linux hosts |
| 2026-10-27 | ChatGPT for iOS 1.2026.293 | 修复转向排队消息/编辑配对码时崩溃，及 iPad 切换/缩放任务卡死 | CL | Fixed crashes when steering queued messages or editing pairing codes, and iPad freezes… |
| 2026-10-27 | Codex CLI 0.165.0 | 新增内置 Google Cloud Vertex AI provider（`model_provider = "gcp"`） | CL | Added a built-in Google Cloud Vertex AI provider, configured with `model_provider = "gcp"` (#56265) |
| 2026-10-27 | Codex CLI 0.165.0 | 模型目录加入 GPT-6.1 Terra | CL | Added GPT-6.1 Terra to the model catalogs (#57337) |
| 2026-10-27 | Codex CLI 0.165.0 | 会话选择器加仓库过滤，agent 指挥中心按目录分组 | CL | Added a repository filter to the session picker and directory grouping to the agent command center (#56308) |
| 2026-10-27 | Codex CLI 0.165.0 | app-server API 新增实验性 attached thread forks | CL | Added experimental attached thread forks to the app-server API (#56351) |
| 2026-10-27 | Codex CLI 0.165.0 | 支持的模型默认开启会话中调整 reasoning effort | CL | Enabled reasoning effort changes during a conversation by default for supported models (#56163) |
| 2026-10-27 | Codex CLI 0.165.0 | 新 profile 默认启用 memory v2，并支持导入外部 Agent 记忆 | CL | Enabled memory v2 by default for fresh profiles and added support for importing external-agent memories (#56211, #56414) |
| 2026-10-27 | Codex CLI 0.165.0 | 修复全新 TUI 会话遵循服务端默认审批 reviewer | CL | Fixed fresh TUI sessions to honor the server's default approval reviewer (#56090) |
| 2026-10-27 | Codex CLI 0.165.0 | 执行设置无效时 TUI 偏好仍可编辑并即时生效 | CL | Kept TUI preferences editable and immediately applicable when execution settings are invalid (#56091) |
| 2026-10-27 | Codex CLI 0.165.0 | 本地响应 future 被丢弃时取消远程 MCP 工具请求 | CL | Cancelled remote MCP tool requests when their local response futures are dropped (#56132) |
| 2026-10-27 | Codex CLI 0.165.0 | 中断或切 Plan 模式后排队消息不再重启工作 | CL | Prevented queued agent messages from restarting work after an interrupt or a switch to Plan mode (#56330) |
| 2026-10-27 | Codex CLI 0.165.0 | provider 报模型不存在时停止重试并保留其错误信息 | CL | Stopped retrying when a provider reports that a model was not found, preserving its error message (#56445) |
| 2026-10-27 | Codex CLI 0.165.0 | 堵上 marketplace URL 校验缺口（Git 可能连到与校验不符的主机） | CL | Closed a marketplace URL validation gap that could allow Git to connect to a different host… (#56263) |
| 2026-10-29 | Codex CLI 0.166.0 | 转录支持键盘选区（词/行/页移动）、集成搜索与可配置快捷键 | CL | Added keyboard-driven transcript selection with word, line, and page motions… (#57221-24) |
| 2026-10-29 | Codex CLI 0.166.0 | 异步问题、选项、回答与转录回复统一渲染 Markdown | CL | Rendered Markdown consistently in async questions, choices, answers, and transcript replies (#57259, #57292) |
| 2026-10-29 | Codex CLI 0.166.0 | bundled/Vertex AI/Amazon Bedrock 模型目录加入 GPT-6.1 Terra | CL | Added GPT-6.1 Terra to the bundled, Vertex AI, and Amazon Bedrock model catalogs (#57293) |
| 2026-10-29 | Codex CLI 0.166.0 | 新增 `codex queue --resume`：排队消息后恢复已卸载线程 | CL | Added `codex queue --resume` to resume unloaded threads after queueing a message (#57232) |
| 2026-10-29 | Codex CLI 0.166.0 | TUI 安全拦截说明更清晰，并提供更安全的后续提示可选 | CL | Added clearer safety-block explanations and selectable safer follow-up prompts in the TUI (#57363, #57365) |
| 2026-10-29 | Codex CLI 0.166.0 | 新增 `codex doctor --network-only` 专项诊断 | CL | Added `codex doctor --network-only` for focused configuration, connectivity, and WebSocket diagnostics (#57606) |
| 2026-10-29 | Codex CLI 0.166.0 | 恢复/分叉线程时保留已确认的审批与权限设置 | CL | Preserved acknowledged approval and permission settings when resuming or forking threads (#57227) |
| 2026-10-29 | Codex CLI 0.166.0 | 恢复被杀 composer 文本时保留本地图片附件 | CL | Preserved local image attachments when restoring killed composer text (#57502) |
| 2026-10-29 | Codex CLI 0.166.0 | 修复 macOS 独立版清理：安装使用中或路径含非 ASCII 时不再出错 | CL | Fixed standalone release cleanup on macOS when installations are in use or paths contain non-ASCII… (#57503) |
| 2026-10-29 | Codex CLI 0.166.0 | 解档父线程时恢复其派生的子线程 | CL | Restored spawned descendant threads when unarchiving their parent (#57635) |
| 2026-10-29 | Codex CLI 0.166.0 | 修复 app-server 线程启停竞态并及时释放运行时 | CL | Fixed app-server thread startup and shutdown races and released completed runtimes promptly (#57787, #57788) |
| 2026-10-29 | Codex CLI 0.166.0 | 改进 TUI 重连恢复，含离线 /quit、/exit | CL | Improved TUI reconnection recovery, including offline `/quit` and `/exit` handling (#57820) |
| 2026-10-29 | Codex CLI 0.166.0 | 恢复/分叉时保留 reasoning token 记账，避免过早压缩 | CL | Preserved reasoning-token accounting across resume and fork to avoid premature compaction (#57839) |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 全屏输入框内直接添加/预览/移除附件 | CL | Add, preview, and remove attachments without leaving the full-screen composer |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 任务已读状态与受支持主机同步，清理跨设备陈旧未读 | CL | Task read status now syncs with supported hosts, helping clear stale unread indicators… |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 追问默认转向正在运行的任务（除非另存偏好） | CL | Follow-ups steer the running task by default unless you have saved a different preference |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 响应批注增强：选中文本加/编注释，点编号引用回看原文 | CL | Improved response annotations: add and edit notes on selected text, and tap numbered references… |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | iOS 端追问时自定义 provider 任务保持模型与 reasoning effort | CL | Custom-provider tasks keep their model and reasoning effort when you send a follow-up from iOS |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 重开任务时发送失败的消息保留附件并可重试 | CL | When you reopen a task, prompts that failed to send retain their attachments, and you can retry… |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 打开任务、滚长草稿、回编辑器时的键盘行为改进 | CL | Improved keyboard behavior when opening tasks, scrolling long drafts, and returning to an open editor |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 草稿、选区、撤销历史在紧凑/分栏布局切换间保留 | CL | Drafts, text selection, and undo history survive changes between compact and split layouts |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | iPhone Duo 布局改进：全宽编辑、控件保持在键盘上方 | CL | Improved iPhone Duo layouts, including full-width editing and controls that stay above the keyboard |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 链接文件直接打开，关预览即回任务；工作区外绝对路径链接也能正确打开 | CL | Linked files open directly, and closing the preview takes you back to the task |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 相对路径图片按原轮运行目录加载 | CL | Images with relative file paths load from the directory where the original turn ran |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 修复内联可视化图表标签/柱不可见 | CL | Fixed invisible chart labels and bars in inline visualizations |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 重连错误统一为单个 Retry 控件，iPad 对齐改进 | CL | Reconnect errors show a single Retry control, with better alignment on iPad |
| 2026-11-02 | ChatGPT for iOS 1.2026.300 | 主机看似离线时归档任务也可重连 | CL | Archiving a task can reconnect to its host when the computer appears offline |

### 2.2 dots 文档中日期不明的表述（如实标注，不猜日期）

出处：https://learn.chatgpt.com/docs/dots 与 https://learn.chatgpt.com/docs/whats-new 。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 日期不明 | — | 给 dot 发短信：iMessage/RCS 一对一收发文字/照片/语音，beta，ChatGPT Pro 美国用户灰度 | /docs/dots | Texting is rolling out in beta to ChatGPT Pro users in the U.S. |
| 日期不明 | — | iOS 主屏幕小组件与快捷指令打开 dot（绑定 ChatGPT iOS 1.2026.279；该版本 changelog 日期为 2026-10-13，**窗口外**） | /docs/whats-new | These features are rolling out with ChatGPT for iOS 1.2026.279 and require dot access |
| 日期不明 | — | 手机 App 内创建 dot（命名、外观、连插件）；同期「更多 ChatGPT/Codex 上下文、更快云浏览、通知与设置修复」 | /docs/whats-new | Create your dot, give it a name, customize its appearance, and connect plugins from your phone |
| 2026-11-18（生效日，窗口外） | — | Enterprise/Edu 工作区 dots 默认开启（可 opt-out）；管理预览期由管理员按角色开通 | /docs/dots | Starting November 18, 2026, access is on by default unless your workspace opts out |

### 2.3 dots 相关阴性发现

- 窗口内（10-26～11-02）ChatGPT & Codex changelog 中**没有 dots 专属条目**（上表 2.1 全部为平台级条目；dots 文档与 Terra 有一条同步表述）。
- support.claude.com 一侧见第 3 节；OpenAI 侧无对应「release notes」页可达（help.openai.com 403）。

---

## 3. Claude Code（github.com/anthropics/claude-code + support.claude.com release notes）

### 版本核实与日期口径

- `CHANGELOG.md` 章节本身**不带日期**；日期取 GitHub release `published_at`，并与 npm registry 发布时间互校（两者差 ≤2 小时；GitHub release 页正文与 CHANGELOG.md 对应章节逐字一致，已抽查 v2.1.311）。
- 窗口内版本：
  - **v2.1.311** npm 2026-10-26T19:47:57Z ／ GH release 2026-10-26T21:51:23Z
  - **v2.1.312** npm 2026-10-27T18:36:10Z ／ GH 2026-10-27T20:24:20Z
  - **v2.1.313** npm／CHANGELOG／GH releases 三处均**不存在**（跳号）
  - **v2.1.314** npm 2026-10-30T00:12:56Z ／ GH 2026-10-30T01:06:26Z
  - **v2.1.315** npm 2026-10-30T21:05:24Z，但 GH release 与 CHANGELOG 均无条目（无变更说明，见第 4 节）
  - **v2.1.316** npm 2026-10-31T00:42:05Z ／ GH 2026-10-31T01:01:35Z
  - **v2.1.317** npm 2026-11-02T23:57:53Z（**窗口内，距边界 2 分钟**）／ GH release 2026-11-03T01:25:46Z（窗口外）。按 npm 发布时间计入窗口并标注分歧。
  - v2.1.318 npm 2026-11-03T21:55Z，窗口外，不列。
- support.claude.com/en/articles/12138966-release-notes（产品级 release notes）：**窗口内无条目**——最近两条为 2026-10-21（Claude Duet research preview）与 2026-11-05（Enterprise 安全管理 + Personal Finance beta），中间为空。记为阴性发现。
- 特别条目：v2.1.316 内含一条带绝对日期的弃用公告（Opus 4.8 fast mode，2026-10-30 起弃用、2026-11-30 移除）。

### 3.1 v2.1.311（2026-10-26）— 92 条

出处列：`R311` = https://github.com/anthropics/claude-code/releases/tag/v2.1.311 （正文同 CHANGELOG.md）。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-10-26 | v2.1.311 | self-hosted runner 新增 --hold-idle-file/--max-hold-min 保持空闲会话 | R311 | Added `--hold-idle-file` and `--max-hold-min` to `self-hosted-runner` |
| 2026-10-26 | v2.1.311 | Explanatory 输出风格新增提示 | R311 | Added a tip for the Explanatory output style |
| 2026-10-26 | v2.1.311 | 修复 CLAUDE.md 超长列表项导致启动/读写长时间卡死 | R311 | Fixed long freezes at startup and after reading or editing files when a CLAUDE.md file holds a very long list item |
| 2026-10-26 | v2.1.311 | 修复 MCP 读资源或技能下载未响应时中断要等超时才生效 | R311 | Fixed interrupting Claude not taking effect until a timeout while an MCP server had not answered… |
| 2026-10-26 | v2.1.311 | 修复标准上下文会话超 200K 误报「需 1M 额度」，现自动压缩续跑 | R311 | Fixed standard-context sessions stopping with "Usage credits required for 1M context" |
| 2026-10-26 | v2.1.311 | 修复千行级 Write/Edit 卡 5 秒且报 0 行变更 | R311 | Fixed Write and Edit stalling for up to 5 seconds after they ran, and reporting 0 lines changed |
| 2026-10-26 | v2.1.311 | 修复子代理用不了晚完成连接的 MCP 服务器工具 | R311 | Fixed subagents being unable to use MCP tools from servers that finish connecting after the subagent starts |
| 2026-10-26 | v2.1.311 | 修复压缩后立即读到旧 MEMORY.md/CLAUDE.md | R311 | Fixed Claude seeing stale MEMORY.md and CLAUDE.md content right after automatic compaction |
| 2026-10-26 | v2.1.311 | 修复 claude -p/SDK 转录消息乱序、保留已撤回消息 | R311 | Fixed `claude -p` and SDK sessions saving transcript messages out of order or keeping messages that were taken back |
| 2026-10-26 | v2.1.311 | 修复 SubagentStop 钩子每约两分钟误触发而非结束触发一次 | R311 | Fixed `SubagentStop` hooks running about twice a minute for each running subagent |
| 2026-10-26 | v2.1.311 | 修复 @ 文件选择器无视 .ignore/.rgignore 取反规则 | R311 | Fixed the @ file picker ignoring `.ignore`/`.rgignore` negation rules |
| 2026-10-26 | v2.1.311 | 修复后台子代理仍在工作时其隔离 worktree 被删 | R311 | Fixed a subagent's isolated worktree being removed while a background subagent it started was still working in it |
| 2026-10-26 | v2.1.311 | 修复 auto 模式后台代理每次唤醒都新开主会话轮 | R311 | Fixed background agents in auto mode that wait on their own shells starting a new main conversation turn on every wake |
| 2026-10-26 | v2.1.311 | 修正 Bash 工具「工作目录始终保留」的不实描述 | R311 | Fixed the Bash tool description claiming the working directory always persists between calls |
| 2026-10-26 | v2.1.311 | 修复环境块标错 shell 名（如 Bash 用 zsh 却标 fish） | R311 | Fixed the environment block naming a shell commands don't run in |
| 2026-10-26 | v2.1.311 | 修复 mcp add/remove 与 /mcp 在仓库子目录下指向当前目录而非 ~/.claude.json 项目条目 | R311 | Fixed `claude mcp add`, `claude mcp remove` and `/mcp` naming the current folder instead of the project entry |
| 2026-10-26 | v2.1.311 | 修复 mcp list/get 连接失败行重复显示错误码 | R311 | Fixed `claude mcp list` and `claude mcp get` showing the error code twice on failed-connection lines |
| 2026-10-26 | v2.1.311 | 修复代理拦截启动请求时 Remote Control 卡 Connecting 约两分钟 | R311 | Fixed Remote Control sessions staying on "Connecting" for about two minutes when a network proxy blocks… |
| 2026-10-26 | v2.1.311 | 修复 Claude 发到云/RC 会话的消息在手机 App 显示为你发的 | R311 | Fixed messages that Claude sends to a cloud or Remote Control session appearing as your own message… |
| 2026-10-26 | v2.1.311 | 修复附件保存失败（磁盘满、超 20 个被丢）原因不告知模型 | R311 | Fixed Claude not being told the cause when a file attached to a message… could not be saved because the disk was full |
| 2026-10-26 | v2.1.311 | 修复 Cowork 云会话 WebFetch/WebSearch 挂死，未完成请求 300 秒后失败 | R311 | Fixed WebFetch and WebSearch hanging on a stalled response in Cowork cloud sessions |
| 2026-10-26 | v2.1.311 | 修复被附着/钉住/有定时的崩溃后台会话不重启 | R311 | Fixed a background session that crashed between turns not being restarted while it was attached, pinned… |
| 2026-10-26 | v2.1.311 | 修正「后台服务无响应」报错建议（原建议命令已禁用） | R311 | Fixed the "background service did not respond" error suggesting the disabled `claude daemon restart` |
| 2026-10-26 | v2.1.311 | 修复 respawn 先起服务再报无匹配会话 | R311 | Fixed `claude respawn <id>` starting the background service before reporting that no background session matches |
| 2026-10-26 | v2.1.311 | 修复 plan 模式下计划模型与会话模型不同时 /effort 不报缓存未命中 | R311 | Fixed `/effort` not warning about a prompt cache miss in plan mode when the plan model differs |
| 2026-10-26 | v2.1.311 | 修复 /ide 在安装未完成或失败时宣称已装 VS Code 扩展 | R311 | Fixed `/ide` saying the VS Code extension was installed before the install finished or when it failed |
| 2026-10-26 | v2.1.311 | 修复 Write 文件预览宽行跳行、隐藏行数算错 | R311 | Fixed the Write tool's file preview skipping rows and miscounting hidden lines |
| 2026-10-26 | v2.1.311 | 修复 agent 聊天标签 ↑ 召回未投递消息导致重复发送 | R311 | Fixed ↑ in an agent's chat tab recalling a message that was still waiting to be delivered |
| 2026-10-26 | v2.1.311 | 修复设置含 agent 时 Cowork 云会话重启丢失连接器与大部分工具（现忽略该设置） | R311 | Fixed Cowork cloud sessions losing their connectors and most tools after a restart when a plugin or your settings named an `agent` |
| 2026-10-26 | v2.1.311 | 修复团队会话恢复后任务列表为空、/branch 写到原会话列表 | R311 | Fixed agent teams sessions showing an empty task list when coming back with `--resume`… |
| 2026-10-26 | v2.1.311 | 修复粘贴含图片路径的文本误附图并从提示中丢路径 | R311 | Fixed pasting text that mentions an image file… attaching the image and dropping its path from the prompt |
| 2026-10-26 | v2.1.311 | 修复反馈草稿卡在有输入时仍显示 1/2/0、Esc 快捷键 | R311 | Fixed the feedback draft card showing its 1/2/0 and Esc shortcuts while the prompt has text |
| 2026-10-26 | v2.1.311 | 修复引号/括号内孤反斜杠从响应中消失 | R311 | Fixed a lone backslash in quotes or brackets, like `"\"` or `(\)`, disappearing from Claude's responses |
| 2026-10-26 | v2.1.311 | 修复设 DISABLE_COMPACT 时 agent 队友仍压缩历史 | R311 | Fixed agent teammates compacting their history when `DISABLE_COMPACT` is set |
| 2026-10-26 | v2.1.311 | 修复 DISABLE_COMPACT 时 rewind 菜单仍提供摘要选项 | R311 | Fixed the rewind menu offering "Summarize from here" and "Summarize up to here" when `DISABLE_COMPACT` is set |
| 2026-10-26 | v2.1.311 | 修复云/后台会话重启后已完成的 /code-review 再跑一遍 | R311 | Fixed a finished `/code-review`, or another skill that runs in a sub-agent, running a second time |
| 2026-10-26 | v2.1.311 | 修复 Vertex/Foundry/CPA 长思考被误判空闲掐断 | R311 | Fixed long hidden thinking being cut off as idle on Google Vertex AI, Microsoft Foundry and Claude Platform on AWS |
| 2026-10-26 | v2.1.311 | 修复 /ide 在未安装时谎报 JetBrains 插件装好 | R311 | Fixed `/ide` saying it had installed the JetBrains plugin when nothing was installed |
| 2026-10-26 | v2.1.311 | 改进订阅不可用报错：指向账单设置而非让找管理员 | R311 | Fixed Claude Pro and Max subscribers being told to ask their admin when their subscription can't be used |
| 2026-10-26 | v2.1.311 | 修复宽全屏终端下空 diff 面板自动弹开 | R311 | Fixed the diff pane opening by itself after an edit in wide fullscreen terminals when it had nothing to show |
| 2026-10-26 | v2.1.311 | 修复「Clear authentication」后免登录远程 MCP 误报失败 | R311 | Fixed `/mcp` showing a remote server as failed after "Clear authentication" when the server works without sign-in |
| 2026-10-26 | v2.1.311 | 修复 /mcp 对无凭据远程服务器误标 authenticated | R311 | Fixed `/mcp` showing "authenticated" for a remote server that Claude Code sends no credentials to |
| 2026-10-26 | v2.1.311 | 修复插件目录顶部空 .mcp.json 导致整目录被当成单个插件 | R311 | Fixed a `--plugin-dir` folder of plugins loading as one plugin when an empty `.mcp.json` was at its top |
| 2026-10-26 | v2.1.311 | 修复 /usage 不显示大额 prompt-cache 未命中 | R311 | Fixed `/usage` never showing large prompt-cache misses under "What's contributing to your limits usage?" |
| 2026-10-26 | v2.1.311 | 修复后台会话状态行链接变纯文本 | R311 | Fixed status line links staying plain text in background sessions |
| 2026-10-26 | v2.1.311 | 修正 /rewind 确认「会分叉」的表述（后续消息是被移除） | R311 | Fixed the /rewind confirmation saying the conversation "will be forked" |
| 2026-10-26 | v2.1.311 | 修正 /rewind 关于手动与 Bash 编辑不受代码恢复影响的错误警告 | R311 | Fixed the /rewind warning that wrongly said manual and Bash edits are never affected by a code restore |
| 2026-10-26 | v2.1.311 | 修复读屏模式计划审批误发已 Esc 掉的反馈 | R311 | Fixed plan approval in screen reader mode sending feedback you had dismissed with Escape |
| 2026-10-26 | v2.1.311 | 修复重试 API 明示不可重试的请求（可拖住一轮数分钟/无人值守模式无限重试） | R311 | Fixed Claude Code retrying requests the API marked not to retry |
| 2026-10-26 | v2.1.311 | Linux：修复 --plugin-dir 同时是附加目录且开了 blockReads 时沙盒 Bash 报 bwrap: Can't create file | R311 | Linux: Fixed sandboxed Bash commands failing with `bwrap: Can't create file` |
| 2026-10-26 | v2.1.311 | runner：附加只读仓库被限流挡住时会话改为不带该仓库启动 | R311 | Self-hosted runner: Fixed a session failing to start when a rate limit… blocks an added read-only repository |
| 2026-10-26 | v2.1.311 | Pro/Max 一小时内重复启动少发两个网络请求，提速 | R311 | Improved startup time for Pro and Max accounts by skipping two network requests on launches within an hour |
| 2026-10-26 | v2.1.311 | /teleport 在云会话从压缩点加载时提示摘要消息不在本地副本 | R311 | Improved `/teleport` and `claude --teleport` to warn when a compacted cloud session loads from its last compaction |
| 2026-10-26 | v2.1.311 | 改进后台会话进程退出的提示（不再许诺不会发生的重启） | R311 | Improved the messages shown when a background session's process exits |
| 2026-10-26 | v2.1.311 | 产物多视图按链接 #name 路由，并更正地址栏说明 | R311 | Improved artifacts with several views: Claude now routes each view on the link's `#name` |
| 2026-10-26 | v2.1.311 | 命令超时改为显示已有输出并说明仍在后台运行 | R311 | Improved shell commands that reach their timeout: the result now shows the output so far |
| 2026-10-26 | v2.1.311 | 压缩响应缺摘要时先补问一次再替换会话 | R311 | Improved compaction: when the model's reply has no summary in it, Claude Code now usually asks for the summary once more |
| 2026-10-26 | v2.1.311 | Artifact 工具页面/文档选择标准更明确 | R311 | Improved the Artifact tool's choice between a page and a document |
| 2026-10-26 | v2.1.311 | 纯选项参数启动（如 claude --model opus）提速 | R311 | Improved startup time for launches whose only arguments are options and their values |
| 2026-10-26 | v2.1.311 | 「连接中断」报错给出排查方向（代理/网关/VPN） | R311 | Improved the "Connection dropped" API error: it now says where to look first |
| 2026-10-26 | v2.1.311 | 读屏模式删除规则即时播报 Deleted allow rule | R311 | Improved screen reader mode: deleting a rule in /permissions says "Deleted allow rule …" right away |
| 2026-10-26 | v2.1.311 | 改进登录码被拒提示（可能过期/已用，请重登） | R311 | Improved the message shown when a pasted sign-in code is refused |
| 2026-10-26 | v2.1.311 | Slack 连接器发消息前检查频道主题中的发帖规则 | R311 | Improved Slack connector sends: Claude now checks a channel's topic for posting rules |
| 2026-10-26 | v2.1.311 | 读屏模式问题列表改为「Questions: …」格式 | R311 | Improved screen reader mode: Claude's questions are listed as "Questions: Color (answered), Pages" |
| 2026-10-26 | v2.1.311 | ultrathink 在交互终端对 Opus 5.5/Sonnet 5.5/Haiku 5.5/Fable 5.1（Anthropic API）跑 xhigh；干活中输入可提升当轮 | R311 | Changed `ultrathink` in the interactive terminal to run its turn at xhigh effort on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 |
| 2026-10-26 | v2.1.311 | ultrathink 彩虹只在关键字能提效时出现（引用/路径中不显示） | R311 | Changed the `ultrathink` rainbow to appear only where the keyword can raise effort |
| 2026-10-26 | v2.1.311 | agent 视图 Ctrl+D 对齐主提示符（空输入按两次退出） | R311 | Changed Ctrl+D in agent view to match the prompt |
| 2026-10-26 | v2.1.311 | JSON/stream-json 输出把 DEL、C1 与格式字符转义为 \uXXXX | R311 | Changed `--output-format json` and `stream-json` output to write DEL, C1 control and Unicode format characters… as `\uXXXX` |
| 2026-10-26 | v2.1.311 | 后缀无效的模型名去掉 [1m] 标记（仍接受） | R311 | Changed model names and IDs to drop the `[1m]` suffix and its label on models where the suffix has no effect |
| 2026-10-26 | v2.1.311 | 设置文件权限规则启动警告改为每用户一次（规则变更前） | R311 | Changed startup warnings about permission rules in settings files to show once per user until the rule changes |
| 2026-10-26 | v2.1.311 | /code-review 指示调整：effort 优先，max 需明确要求 | R311 | Changed `/code-review` to tell Claude to put the effort level first and use max only when asked |
| 2026-10-26 | v2.1.311 | 设置与 mod env.set 里的 DISABLE_COMPACT 只能关不能开 | R311 | Changed `DISABLE_COMPACT` in settings files and in a mod's `$.env.set` so they can only turn compaction off, not back on |
| 2026-10-26 | v2.1.311 | Bedrock/Mantle/Vertex/Foundry 模型设置改为从 downloads.claude.ai 签名文件加载（可 CLAUDE_CODE_MODEL_CATALOG=off 关闭） | R311 | Changed Claude Code on Bedrock, Mantle, Vertex, and Foundry to load model settings from a signed file on downloads.claude.ai |
| 2026-10-26 | v2.1.311 | CLAUDE_CODE_SYNC_SKILLS 会话复用 ≤10 分钟的 claude.ai 技能列表缓存 | R311 | Changed sessions that set `CLAUDE_CODE_SYNC_SKILLS` with feature-flag fetching off to reuse a claude.ai skills list up to 10 minutes old |
| 2026-10-26 | v2.1.311 | 全屏列表滚动条点击改为松开生效（移开即取消） | R311 | Changed clicks on scrollbar arrows and bars in fullscreen lists to act when the mouse button is released |
| 2026-10-26 | v2.1.311 | claude purge 文案说明只删本机数据 | R311 | Changed `claude purge` to say it deletes data only on this computer |
| 2026-10-26 | v2.1.311 | VSCode：回复代码块语法高亮（亮/暗/高对比暗） | R311 | [VSCode] Added syntax coloring to code blocks in Claude's replies |
| 2026-10-26 | v2.1.311 | VSCode：慢 UserPromptSubmit 钩子加转圈状态与读屏播报 | R311 | [VSCode] Added a "Running UserPromptSubmit hooks" spinner status and screen reader announcement |
| 2026-10-26 | v2.1.311 | VSCode：面板发自定义技能/斜杠命令补上当前文件与选区 | R311 | [VSCode] Fixed custom skills and custom slash commands sent from the VS Code or JetBrains panel leaving out the open file… |
| 2026-10-26 | v2.1.311 | VSCode：修复登录 shell 起动文件读 PATH 时扩展宿主卡死（macOS/Linux） | R311 | [VSCode] Fixed the extension host freezing while the login shell ran its start-up files to read PATH |
| 2026-10-26 | v2.1.311 | VSCode：点工具结果图片/关预览不再把文本开进编辑器标签 | R311 | [VSCode] Fixed clicking an image in a tool result, or closing its preview, also opening the result's text |
| 2026-10-26 | v2.1.311 | VSCode：点发送后先停听写 | R311 | [VSCode] Fixed voice dictation continuing to record after a message was sent with the Send button |
| 2026-10-26 | v2.1.311 | VSCode：VS Code 遥测关闭时会话带 DISABLE_TELEMETRY 启动 | R311 | [VSCode] Changed the extension to start Claude Code sessions with `DISABLE_TELEMETRY` set while VS Code's telemetry setting is off |
| 2026-10-26 | v2.1.311 | VSCode：Web 会话改为首次打开 Web 标签才加载 | R311 | [VSCode] Changed the session list side bar to load Web sessions when the Web tab is first opened |
| 2026-10-26 | v2.1.311 | 云会话：修复成员退出又重进组织后 routine 锁死 | R311 | [Cloud sessions] Fixed routines in Anthropic-hosted environments staying locked after their owner left the organization and rejoined |
| 2026-10-26 | v2.1.311 | 云会话：修复 routine API token 删除/重生成失败无提示 | R311 | [Cloud sessions] Fixed a failed routine API token delete or regenerate showing nothing |
| 2026-10-26 | v2.1.311 | 云会话：环境对话框拒绝重名 | R311 | [Cloud sessions] Fixed cloud environment dialogs, including the admin dialog, accepting duplicate names |
| 2026-10-26 | v2.1.311 | Claude Tag 分析新增 Skills 视图（Slack 频道技能使用统计） | R311 | [Claude Tag] Added a Skills view to Claude Tag analytics |
| 2026-10-26 | v2.1.311 | Claude Tag：新会话 routine 空跑可结束不发废消息 | R311 | [Claude Tag] Improved Claude Tag routines that run in a new session: a run with nothing to report can now end |
| 2026-10-26 | v2.1.311 | Claude Tag：自己账号可见的私频道在管理设置显示锁 | R311 | [Claude Tag] Changed Claude Tag admin settings to show a lock instead of # for private Slack channels |
| 2026-10-26 | v2.1.311 | Code Review：检查运行说明自动重审不再继续 | R311 | [Code Review] Improved Code Review's check run to say no further automatic review will start |
| 2026-10-26 | v2.1.311 | Code Review：会话因瞬时服务故障起不来时自动重试一次 | R311 | [Code Review] Improved Code Review reliability: a review whose session fails to start because of a transient server fault is now retried once |

### 3.2 v2.1.312（2026-10-27）— 39 条

出处列：`R312` = https://github.com/anthropics/claude-code/releases/tag/v2.1.312 。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-10-27 | v2.1.312 | 网关新增 oidc.user_id_claim（可按 Entra ID oid 等 claim 识别人） | R312 | Added `oidc.user_id_claim` to the Claude apps gateway |
| 2026-10-27 | v2.1.312 | 全屏模式点击排队消息下方「to send now」提示即发送 | R312 | Added click to send: in fullscreen, clicking the "to send now" hint under a queued message sends it right away |
| 2026-10-27 | v2.1.312 | 修复 VSCode 登录后本会话不再拉取托管设置与组织策略 | R312 | Fixed managed settings and organization policy not being fetched for the rest of the session after signing in from the VS Code extension |
| 2026-10-27 | v2.1.312 | 修复 Write 只看开头就覆写超大 CLAUDE.md/rules/@引用文件（现要求读全或原地编辑） | R312 | Fixed Claude overwriting a very large CLAUDE.md, rules file or @-included file… after seeing only its start |
| 2026-10-27 | v2.1.312 | 修复 Bash cd 深入仓库后按目录/paths: 技能找不到 | R312 | Fixed per-directory and `paths:` skills not being found after a Bash `cd` deeper into a git repository |
| 2026-10-27 | v2.1.312 | 修复恢复会话后下次恢复可能丢首次回复 | R312 | Fixed a rare case where the first reply after resuming a session in the terminal could be missing the next time… |
| 2026-10-27 | v2.1.312 | 修复无效命令名阻断全部命令加载（claude -p 无输出） | R312 | Fixed a command with an invalid name stopping all commands from loading |
| 2026-10-27 | v2.1.312 | 修复会话清理并发运行时 Read 读 PDF 报 pdftoppm failed | R312 | Fixed the Read tool sometimes failing on PDF pages with "pdftoppm failed: Could not write image" |
| 2026-10-27 | v2.1.312 | 修复新选 effort 未生效就显示在转圈/OTel/转录里 | R312 | Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task |
| 2026-10-27 | v2.1.312 | 修正 /model 与 /effort 缓存警告文案（改动可更早触发重读） | R312 | Fixed the `/model` and `/effort` cache warning saying the re-read waits for your next message |
| 2026-10-27 | v2.1.312 | 修复句中提及待办导致会话误标「等你处理」 | R312 | Fixed some sessions showing as waiting on you when the last message only mentioned items waiting on you mid-sentence |
| 2026-10-27 | v2.1.312 | 修复 agent 视图退出前 Ctrl+C 清空的输入在下次启动被恢复 | R312 | Fixed agent view restoring input text on the next launch after it was cleared with Ctrl+C just before exiting |
| 2026-10-27 | v2.1.312 | 修复 agent 视图从空 ! 输入 Ctrl+D 退出后重开进 shell 模式 | R312 | Fixed agent view reopening in shell mode after exiting with Ctrl+D from an empty `!` input |
| 2026-10-27 | v2.1.312 | 修复 vim d/c/y 带 gj/gk 计数越界删复制（与 Vim 一致只移光标） | R312 | Fixed vim mode `d`, `c` and `y` with a `gj` or `gk` count larger than the lines left |
| 2026-10-27 | v2.1.312 | 修复 /verify 在 /help 与命令菜单显示面向 Claude 的长描述 | R312 | Fixed `/verify` showing a long description meant for Claude in `/help` and the `/` command menu |
| 2026-10-27 | v2.1.312 | effort 指示器改进：干活中改动说明可能等下条消息，失效即清除 | R312 | Improved the prompt's effort indicator: a change made mid-task now says it may wait for your next message |
| 2026-10-27 | v2.1.312 | 云会话 WebFetch 报错说明可能是域名未在允许网络内 | R312 | Improved WebFetch errors in cloud sessions: a host that does not resolve is now explained as possibly outside the allowed network domains |
| 2026-10-27 | v2.1.312 | Bedrock/Vertex/Foundry/Mantle 对未识别模型名改用短系统提示词（可关） | R312 | Changed Bedrock, Vertex, Foundry and Mantle to use the shorter system prompt for model names Claude Code doesn't recognize |
| 2026-10-27 | v2.1.312 | 拒答回退换模型覆盖自定义部署名等未识别模型名（可关） | R312 | Changed automatic model switches after a flagged message to also cover model names Claude Code doesn't recognize |
| 2026-10-27 | v2.1.312 | 用量文案改口「5-hour limit」（原 session limit） | R312 | Changed usage limit messages to call the 5-hour window the "5-hour limit" instead of the "session limit" |
| 2026-10-27 | v2.1.312 | CLI 发起的云会话名称与分支名改从服务端取 | R312 | Changed cloud sessions started from the CLI to get their names and branch names from the server |
| 2026-10-27 | v2.1.312 | 提示/agent 钩子每会话并发上限 24（含子代理），超时另限 12；<1 秒超时按 1 秒 | R312 | Changed prompt and agent hooks to run at most 24 at a time per session, sub-agents included |
| 2026-10-27 | v2.1.312 | 子代理 autoCompactWindow 现可调小全局窗口（仍不能调大） | R312 | Changed a subagent's `autoCompactWindow` to lower the window set by `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| 2026-10-27 | v2.1.312 | OTel mcp_server.name 报官方市场固定 URL 远程 MCP 真名（原 custom） | R312 | Changed OpenTelemetry `mcp_server.name` to report the real name of fixed-URL remote MCP servers… |
| 2026-10-27 | v2.1.312 | 停发 claude_code.safety_event OTel 事件 | R312 | Changed Claude Code to stop sending the `claude_code.safety_event` OpenTelemetry event |
| 2026-10-27 | v2.1.312 | VSCode：组织设置加载失败不再裸退出，说明原因并给 Retry/重新登录 | R312 | [VSCode] Fixed sessions ending on a bare exit code when your organization's settings couldn't be loaded or were refused |
| 2026-10-27 | v2.1.312 | VSCode：用量重置显示具体时刻（Resets at 3:10 PM）并说 5-hour limit | R312 | [VSCode] Changed usage limit resets to show a clock time ("Resets at 3:10 PM") and to say "5-hour limit" |
| 2026-10-27 | v2.1.312 | 云会话：routine 模型选择器增加 effort 档 | R312 | [Cloud sessions] Added an effort level to the model picker when you create or edit a routine that runs in the cloud |
| 2026-10-27 | v2.1.312 | 云会话：环境设置 setup 脚本框换彩色 Bash 编辑器（行号+复制） | R312 | [Cloud sessions] Added a Bash editor with colors, line numbers and a Copy button to the setup script box |
| 2026-10-27 | v2.1.312 | 云会话：加仓库步骤显示简表而非裸 JSON | R312 | [Cloud sessions] Improved the step shown when Claude adds a repository to a cloud session |
| 2026-10-27 | v2.1.312 | 云会话：修复失败后重发未改动消息会跑两次 | R312 | [Cloud sessions] Fixed resending an unchanged message after a failed send in a cloud session sometimes running it twice |
| 2026-10-27 | v2.1.312 | 云会话：环境创建失败报错进对话框（原只在 toast） | R312 | [Cloud sessions] Fixed a failed cloud environment creation showing its error only as a toast outside the open dialog |
| 2026-10-27 | v2.1.312 | 云会话：Routines 页 Edit 打开编辑对话框（原只跳页） | R312 | [Cloud sessions] Fixed Edit in a routine's menu on the Routines page going to the routine's page without opening its edit dialog |
| 2026-10-27 | v2.1.312 | Remote Control：未归档会话误显「工作中」改空闲 | R312 | [Remote Control] Fixed an unarchived Remote Control session showing as working until a computer reconnected; it now shows as idle |
| 2026-10-27 | v2.1.312 | Claude Tag：重试提示点名所用模型或说明限流 | R312 | [Claude Tag] Improved Claude Tag's retry notice in Slack to name the model in use, or say rate limits were hit |
| 2026-10-27 | v2.1.312 | Claude Tag：私频道转公开换 ID 后设置不再回退默认 | R312 | [Claude Tag] Fixed a Claude Tag channel's on/off switch and agent settings falling back to workspace defaults |
| 2026-10-27 | v2.1.312 | Claude Tag：网络权限为 None 的频道也能正常回复 | R312 | [Claude Tag] Fixed Claude in Slack not replying in channels whose environment has network access set to None |
| 2026-10-27 | v2.1.312 | Claude Tag：跨线程答复时文件不再发错线程 | R312 | [Claude Tag] Fixed Claude in Slack sometimes posting a file in the wrong thread |
| 2026-10-27 | v2.1.312 | Code Review：push 事件迟到时审查当前 commit（原审旧 commit 或漏审） | R312 | [Code Review] Fixed Code Review reviewing an outdated commit, or none at all, when GitHub delivered a push event late |

### 3.3 v2.1.314（2026-10-30）— 119 条

出处列：`R314` = https://github.com/anthropics/claude-code/releases/tag/v2.1.314 。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-10-30 | v2.1.314 | 新增 permissions.blockWritesOutsideWorkingDirectories：所有权限模式下拒绝工作目录外写入 | R314 | Added `permissions.blockWritesOutsideWorkingDirectories`: Write, Edit and NotebookEdit refuse paths outside… |
| 2026-10-30 | v2.1.314 | 网关上游支持按 IdP 组路由（含故障转移） | R314 | Added an optional `groups` list to Claude apps gateway upstreams |
| 2026-10-30 | v2.1.314 | 网关 Bedrock 上游新增 guardrail_trace 日志（记录哪个护栏触发） | R314 | Added `guardrail_trace` to Claude apps gateway Bedrock upstreams |
| 2026-10-30 | v2.1.314 | VSCode 与桌面 Code 标签页新增空闲压缩（200K+ 会话闲置后摘要） | R314 | Added idle compaction to VS Code and Claude Desktop's Code tab |
| 2026-10-30 | v2.1.314 | 修复管理员限 effort 后轮轮报 Invalid effort level：现自动降档重试并说明 | R314 | Fixed sessions failing turn after turn with "Invalid effort level" when an organization's admin caps a model's effort |
| 2026-10-30 | v2.1.314 | 修复 claude -p 启动失败静默退出 0：现打印错误退出 1 | R314 | Fixed `claude -p` exiting with code 0 and no output when startup failed |
| 2026-10-30 | v2.1.314 | 修复 Bedrock 多图会话轮轮报 400 Input is too long：现删旧图压缩 | R314 | Fixed Bedrock sessions with many images failing every turn and `/compact` with "400 Input is too long." |
| 2026-10-30 | v2.1.314 | Foundry 缺默认模型部署时回退同族旧模型 | R314 | Fixed Microsoft Foundry sessions failing when the resource has no deployment for the default Sonnet, Opus or Haiku model |
| 2026-10-30 | v2.1.314 | 网关不支持 tool_reference 时自动降级重试一次并记住 | R314 | Fixed repeated refused requests behind a gateway that doesn't accept tool search's `tool_reference` blocks |
| 2026-10-30 | v2.1.314 | 修复交叉签名新根证书致 TLS 报 UNABLE_TO_GET_ISSUER_CERT | R314 | Fixed TLS connections failing with `UNABLE_TO_GET_ISSUER_CERT` when the system certificate store holds a renewed root certificate |
| 2026-10-30 | v2.1.314 | 修复免登录 MCP 存储登录失效后误报 needs authentication（现登出态可用） | R314 | Fixed MCP servers that also work without sign-in showing "needs authentication" after their stored sign-in stopped working |
| 2026-10-30 | v2.1.314 | 修复 mcp logout 在登录未移除时（如 SSH 下钥匙串锁定）谎报成功 | R314 | Fixed `claude mcp logout` reporting success when the MCP sign-in was not removed |
| 2026-10-30 | v2.1.314 | 修复共享登录且凭据锁忙时重复续期 | R314 | Fixed extra sign-in renewals when several sessions share an Anthropic profile login and the credentials lock is busy |
| 2026-10-30 | v2.1.314 | CI 有终端时 ultrareview/remote-control 不再问信任问题，直接拒未信目录 | R314 | Fixed `claude ultrareview` and `claude remote-control` asking the workspace trust question in a CI job that has a terminal |
| 2026-10-30 | v2.1.314 | 修复托管设置里的管理员 TLS 信任未用于桌面会话 | R314 | Fixed an administrator's TLS trust settings in managed settings not being applied in Claude Desktop sessions |
| 2026-10-30 | v2.1.314 | 修复托管插件设置下自家坏清单插件挡住模型切换 | R314 | Fixed model switching being refused on machines with managed plugin settings when one of your own… plugins had a broken manifest |
| 2026-10-30 | v2.1.314 | 修复托管设置钉死模型时 Bedrock/Vertex 升级弹窗每次启动都弹 | R314 | Fixed the Bedrock and Vertex model upgrade offer coming back at every start when managed settings pin the model |
| 2026-10-30 | v2.1.314 | 修复 forceRemoteSettingsRefresh 过期后失效导致无策略启动 | R314 | Fixed `forceRemoteSettingsRefresh` set only in remote managed settings no longer applying once the stored copy had expired |
| 2026-10-30 | v2.1.314 | 修复用量等待间任务重启导致自动续跑超 3 次 | R314 | Fixed "Continue automatically at usage limit" continuing more than three times without a prompt from you |
| 2026-10-30 | v2.1.314 | 修复后台/云会话关掉 Ultracode 后下次启动又自动开 | R314 | Fixed background and cloud sessions started with Ultracode turning it back on at their next start |
| 2026-10-30 | v2.1.314 | 修复放弃解析不了的工具调用后坏回复与重试提示留在对话 | R314 | Fixed the last broken reply and its retry prompts staying in the conversation after Claude gave up on a tool call |
| 2026-10-30 | v2.1.314 | PreCompact 钩子超大输出导致压缩失败：每钩子输出截 1 万字符 | R314 | Fixed a PreCompact hook with very large output making compaction fail or repeat; each hook's output is now cut at 10,000 characters |
| 2026-10-30 | v2.1.314 | 修复后台 diff 刷新抢 .git/index.lock 致并发 git 失败 | R314 | Fixed background diff refreshes briefly taking the repository's index lock |
| 2026-10-30 | v2.1.314 | 修复流式时 Markdown 表格布局抖动、长表回退裸竖线 | R314 | Fixed markdown tables jumping between grid and stacked layouts on half-typed rows while streaming |
| 2026-10-30 | v2.1.314 | 修复只跑斜杠命令的会话在 /resume 列表标题显示 CLAUDE.md 文本 | R314 | Fixed the /resume picker showing the text of CLAUDE.md or CLAUDE.local.md as a session's title |
| 2026-10-30 | v2.1.314 | 修复从子代理转录发起 /btw 却答主对话 | R314 | Fixed `/btw` answering from the main conversation when asked from a subagent's open transcript |
| 2026-10-30 | v2.1.314 | 修复 SSH 到 Linux 粘贴图片静默无效（改提示复制文件后粘路径） | R314 | Fixed pasting an image over SSH to a Linux machine doing nothing silently |
| 2026-10-30 | v2.1.314 | 修复会话服务短暂慢时 remote-control 会话起不来（登记改退避重试） | R314 | Fixed `claude remote-control` sessions that failed to start when the session service was slow for a moment |
| 2026-10-30 | v2.1.314 | 修复 RC 上超 8 秒的模型切换误报 still pending | R314 | Fixed model switches over Remote Control that take over 8 seconds getting a "still pending" error |
| 2026-10-30 | v2.1.314 | 修正 sandbox.excludedCommands 说明（调用内每条命令都须匹配） | R314 | Fixed the `sandbox.excludedCommands` setting description saying listed commands always run outside the sandbox |
| 2026-10-30 | v2.1.314 | 修复被 auto 模式/拒绝规则/PreToolUse 钩子拦下的调用显示成已运行 | R314 | Fixed shell and MCP calls that auto mode, a deny rule or a PreToolUse hook blocked… reading as if they ran |
| 2026-10-30 | v2.1.314 | 修复 claude -p --resume/--continue 进 worktree 不套沙盒 | R314 | Fixed sandbox protections not applying to a worktree entered by `claude -p --resume` or `--continue` |
| 2026-10-30 | v2.1.314 | 修复 Monitor 工具起的 shell 命令不触发 Bash 钩子（可拦可问，不可批准/改写） | R314 | Fixed hooks matching Bash not running on shell commands started by the Monitor tool |
| 2026-10-30 | v2.1.314 | 修复 --setting-sources 排除的设置文件仍供部分设置 | R314 | Fixed a settings file excluded with `--setting-sources` still supplying some settings |
| 2026-10-30 | v2.1.314 | 修复安全检查无结论时 auto 模式误报已拦截并列进 /permissions | R314 | Fixed auto mode reporting a call as blocked… when its safety check gave no verdict |
| 2026-10-30 | v2.1.314 | 修复网关 Vertex 上游 token 端点接受连接但不应答时挂数分钟 | R314 | Fixed a Claude apps gateway Vertex upstream hanging for minutes when a Google token endpoint accepts the connection and never answers |
| 2026-10-30 | v2.1.314 | 修正网关对已弃用桌面密钥的启动警告文案 | R314 | Fixed the Claude apps gateway's start-up warning for a deprecated Claude Desktop key… saying "stops being accepted" after the key's end date |
| 2026-10-30 | v2.1.314 | 修复应用商店/Play 计费用户 /upgrade 误开浏览器登录（改告知在哪改套餐） | R314 | Fixed `/upgrade` opening the browser and starting a new login for plans billed through the App Store or Google Play |
| 2026-10-30 | v2.1.314 | 修复 --resume/拒绝后回退换模型把未识别模型名的会话改绑到别的模型 | R314 | Fixed `--resume`, and rewinding past a switch to another model after a refusal, moving a session on a model name Claude Code doesn't recognize… |
| 2026-10-30 | v2.1.314 | 修复网关/云 provider 点名拒绝 beta 头导致请求失败（自动去头重发） | R314 | Fixed requests failing when a gateway or cloud provider refuses one of Claude Code's beta headers by name |
| 2026-10-30 | v2.1.314 | 修复 LLM 网关后带点模型 ID（如 claude-opus-4.8）被当旧模型（错上下文/限额） | R314 | Fixed model IDs spelled with a dot behind an LLM gateway, such as `claude-opus-4.8`, being treated as an older model |
| 2026-10-30 | v2.1.314 | 修复 RC 客户端 /compact 后出现多余 Compacted 行 | R314 | Fixed Remote Control clients showing a stray "Compacted (ctrl+o to see full summary)" row after /compact |
| 2026-10-30 | v2.1.314 | 修复组织策略关闭云会话/RC 时仍显示对应提示 | R314 | Fixed the cloud sessions tip and the Remote Control idle notice showing when an organization's policy turns those features off |
| 2026-10-30 | v2.1.314 | 修复恢复云会话在前 worker 刚收完新会话文件后停机时多发一次无人要的模型调用 | R314 | Fixed a resumed claude.ai cloud session making a model call nobody asked for |
| 2026-10-30 | v2.1.314 | Cowork 云会话 WebFetch 静默丢 PDF 超 10 万字符文本：现提示未读量与去处 | R314 | Fixed WebFetch in Cowork cloud sessions silently dropping a PDF's text past 100,000 characters |
| 2026-10-30 | v2.1.314 | 云会话/IDE 里 Esc/Stop 停命令时告知模型「命令可能已执行」 | R314 | Fixed Claude being told only that a command was declined after you stopped it with Esc or Stop |
| 2026-10-30 | v2.1.314 | 修复引用内代码块首部空行丢失 | R314 | Fixed blank lines at the top of a code block disappearing when the code block opens a quote |
| 2026-10-30 | v2.1.314 | 修复转录视图 ⎿ 行上方多余空行 | R314 | Fixed a blank line appearing above some `⎿` rows in the transcript view (Ctrl+O) |
| 2026-10-30 | v2.1.314 | 修复 vim dw/dW/yw/yW 越行尾继续，w/W 在空行停 | R314 | Fixed vim mode `dw`, `dW`, `yw` and `yW` carrying on past the end of the line |
| 2026-10-30 | v2.1.314 | 修复 agent 面板 x/Enter 在代理增减时作用错对象 | R314 | Fixed x and Enter in the agent panel sometimes acting on the wrong agent when another agent started or finished |
| 2026-10-30 | v2.1.314 | 修复问题对话框非 Other 聚焦时粘贴文本/拖入文件丢失 | R314 | Fixed pasted text and dragged-in files being lost in Claude's question dialog unless the "Other" row had focus |
| 2026-10-30 | v2.1.314 | 修复提示页脚行选中时粘贴文本丢失 | R314 | Fixed pasted text being lost when a row in the prompt footer was selected |
| 2026-10-30 | v2.1.314 | 修复 vim p 对字符选区无视整行 yank | R314 | Fixed vim mode `p` over a character selection ignoring whether the yanked text was whole lines |
| 2026-10-30 | v2.1.314 | 修复 vim aw/iw 吞行尾换行 | R314 | Fixed vim mode `aw` and `iw` taking the line break at the end of a line |
| 2026-10-30 | v2.1.314 | 修复 ↓ 选中被 ? 菜单/命令列表/粘贴提示遮住的页脚项 | R314 | Fixed ↓ selecting footer items hidden by the ? help menu, the command list or a paste hint |
| 2026-10-30 | v2.1.314 | 修复 /btw 等命令面板按 Esc 连带中断打开着转录的子代理 | R314 | Fixed Esc on a command's panel, such as `/btw`, also interrupting the subagent whose transcript is open |
| 2026-10-30 | v2.1.314 | 修复全屏头部在看别的模型的子代理/队友时显示会话模型 | R314 | Fixed the welcome header in fullscreen mode showing the session's model while viewing a subagent or teammate… |
| 2026-10-30 | v2.1.314 | 修复上滚时 Restore conversation 后全屏转录停在会话中部 | R314 | Fixed the fullscreen transcript being left mid-conversation after "Restore conversation"… while scrolled up |
| 2026-10-30 | v2.1.314 | 修复已删会话在恢复列表以近空条目复活 | R314 | Fixed a rare case where a deleted session could reappear in the resume list as an almost empty entry |
| 2026-10-30 | v2.1.314 | 修复含 <bash-stdout> 等标签的提示不回执给本地 stream-json 宿主 | R314 | Fixed prompts containing tags such as `<bash-stdout>` or `<local-command-stdout>` not being acknowledged to a local stream-json host |
| 2026-10-30 | v2.1.314 | 修复首轮失败（如用量限制）后会话一直无标题 | R314 | Fixed sessions staying untitled when the first prompt failed (for example on a usage limit) |
| 2026-10-30 | v2.1.314 | 修复技能文件监视器扫 ~/.claude/skills/.trash 全部残留（负载随删除增长） | R314 | Fixed the skill file watcher checking every removed skill kept in `~/.claude/skills/.trash` |
| 2026-10-30 | v2.1.314 | 修复等待权限/计划决定时 /rename 会话名消失 | R314 | Fixed the session name from /rename disappearing while Claude asks for permission or a plan decision |
| 2026-10-30 | v2.1.314 | 修复启动失败的后台会话误报 daemon 二进制被删 | R314 | Fixed background sessions that fail to start being reported as a deleted daemon binary when the binary is still on disk |
| 2026-10-30 | v2.1.314 | 修复 /config 隐藏推送设置或组织关 RC 时仍弹推送提示与空闲提醒 | R314 | Fixed the tip and idle reminder about push notifications appearing when the push settings in `/config` are hidden… |
| 2026-10-30 | v2.1.314 | 修复 skills/.trash 与 plugins/.trash 无限增长（各留约 1024 条） | R314 | Fixed `~/.claude/skills/.trash` and `~/.claude/plugins/.trash` growing without limit |
| 2026-10-30 | v2.1.314 | 修复 CRLF 文件未改动重存或单行编辑时 Bash 编辑 diff 把整文件列为已改 | R314 | Fixed the Bash edit diff listing a whole file as changed when a CRLF file under git's line-ending conversion was re-saved unchanged |
| 2026-10-30 | v2.1.314 | runner：暂停请求断连时空闲会话改为暂停而非迁往别的 runner | R314 | Self-hosted runner: Fixed an idle session moving to another runner instead of pausing |
| 2026-10-30 | v2.1.314 | 长 headless/SDK 轮多子代理内存优化（父会话不再留存全部子代理工具结果） | R314 | Improved memory use in long headless and SDK turns that run many subagents |
| 2026-10-30 | v2.1.314 | Ctrl+R 历史匹配 [Pasted text] 折叠 pill 内文本 | R314 | Improved prompt history: Ctrl+R now matches text inside collapsed `[Pasted text]` pills |
| 2026-10-30 | v2.1.314 | /design-sync 上传提示显示将上传/删除的文件夹、项目与文件 | R314 | Improved the `/design-sync` upload prompt to show the folder, the project and the files it will upload or delete |
| 2026-10-30 | v2.1.314 | /permissions 审查标签改名 Recently blocked，页脚说明 Esc 行为 | R314 | Improved `/permissions` review tab, now called Recently blocked |
| 2026-10-30 | v2.1.314 | auto 模式拦截信息改进：点名命令、说明可能重试、指向 /permissions | R314 | Improved auto mode's blocked calls: messages name the command, say Claude may retry and auto mode checks again |
| 2026-10-30 | v2.1.314 | 权限弹窗长理由压缩行数，减少挤出待批准命令 | R314 | Improved permission prompts: a long reason takes fewer rows |
| 2026-10-30 | v2.1.314 | 登录被拒重试期间的云会话错误提示建议 claude auth login | R314 | Improved the cloud session error shown while a request refused for your claude.ai login is still being retried |
| 2026-10-30 | v2.1.314 | MDM 与远程设置在 base URL/apiKeyHelper 不一致时存储登录行为改进 | R314 | Improved the behavior of stored claude.ai, Team, and Enterprise logins when MDM and remote settings differ |
| 2026-10-30 | v2.1.314 | agent 视图 /config 说明如何阻止默认打开 agent 视图 | R314 | Improved `/config` in agent view to say how to stop agent view opening by default |
| 2026-10-30 | v2.1.314 | 以技能或 /security-review 类命令开场的会话自动取标题 | R314 | Improved session auto-titles: a session that starts with a skill or a prompt-based command… now gets a title from it |
| 2026-10-30 | v2.1.314 | 损坏转录下 --resume 提速省内存 | R314 | Improved `--resume` speed and memory use on damaged transcripts |
| 2026-10-30 | v2.1.314 | 万级 MCP 工具会话 /context 提速 | R314 | Improved `/context` speed in sessions with ten thousand or more MCP tools |
| 2026-10-30 | v2.1.314 | runner：分支不在远端错误信息覆盖未推送分支并给修法 | R314 | Self-hosted runner: Improved the error shown when a session's branch isn't on the git remote |
| 2026-10-30 | v2.1.314 | /claude-api 技能更新（Datadog 头、去 xattr 步骤） | R314 | Updated the `/claude-api` skill: its Datadog setup… now sends the `dd-llmobs-enabled: true` header |
| 2026-10-30 | v2.1.314 | dataviz 技能更新：1 万以下 y 轴刻度全打 | R314 | Updated the bundled dataviz skill to advise printing y-axis tick labels in full under 10,000 |
| 2026-10-30 | v2.1.314 | dataviz 技能更新：环形/饼图改用排名条形或分段条 | R314 | Updated the bundled dataviz skill to answer donut and pie chart requests with ranked bars or a segmented bar |
| 2026-10-30 | v2.1.314 | 文件工具编辑组织服务端托管设置的本地副本前先征求同意 | R314 | Changed Claude's file tools to ask before editing the local copy of your organization's server-managed settings |
| 2026-10-30 | v2.1.314 | /ultrareview 跑 git 前先检查工作区信任 | R314 | Changed `/ultrareview` to check workspace trust before it runs git |
| 2026-10-30 | v2.1.314 | Bash shell 清除继承的 which 别名/函数，不再传导出 which/unsetenv 函数 | R314 | Changed the Bash tool's shell to clear any inherited `which` alias or function |
| 2026-10-30 | v2.1.314 | /permissions Recently blocked 拒绝批准读不全的调用（含终端过短） | R314 | Changed `/permissions` Recently blocked to refuse approving a call you can't read in full |
| 2026-10-30 | v2.1.314 | Cowork 云会话 auto 模式：钩子放行 MCP 调用视为未答，仍由分类器/权限弹窗决定 | R314 | Changed auto mode in Cowork cloud sessions: a hook's allow of an MCP tool call now counts as no answer |
| 2026-10-30 | v2.1.314 | 钩子 if 条件 Monitor(tail *) 现匹配 Monitor 工具的 shell 命令 | R314 | Changed hook `if` conditions such as `Monitor(tail *)` to match the Monitor tool's shell commands |
| 2026-10-30 | v2.1.314 | claude-api 技能改 agent 前先读 workflow run | R314 | Changed the `claude-api` skill to ask to read a Managed Agents workflow run's workflow before changing the agent |
| 2026-10-30 | v2.1.314 | 拒标请求在只剩旧 Opus（或没有）时改试其他模型而非以拒告终 | R314 | Changed flagged requests to retry on another model, not end in a refusal… leaves only an older Opus model, or none |
| 2026-10-30 | v2.1.314 | 空闲压缩扩展到关遥测订阅者与 Bedrock/Vertex/Foundry/网关（缓存开启时） | R314 | Changed idle compaction to also run for subscribers with telemetry turned off, and on Bedrock, Vertex, Foundry and LLM gateways |
| 2026-10-30 | v2.1.314 | FORCE_HYPERLINK=false/no/off 改为关闭超链接 | R314 | Changed `FORCE_HYPERLINK=false` (also `no` and `off`) to turn hyperlinks off instead of on |
| 2026-10-30 | v2.1.314 | macOS：Claude 大多数 git grep 改 C locale，规避系统正则库非 UTF-8 文件内存泄漏 | R314 | macOS: Changed `git grep` in most commands that Claude runs to use the C locale |
| 2026-10-30 | v2.1.314 | VSCode：修复 MCP Clear authentication 在未移除时报成功 | R314 | [VSCode] Fixed "Clear authentication" for MCP servers reporting success when the saved sign-in could not be removed |
| 2026-10-30 | v2.1.314 | VSCode：修复排队消息钩子运行时缺转圈与停止按钮 | R314 | [VSCode] Fixed missing spinner and Stop button while a queued message's hooks run |
| 2026-10-30 | v2.1.314 | VSCode：无法保存的会话分组改动不再静默失败 | R314 | [VSCode] Fixed session group changes that cannot be saved, such as a delete, failing silently |
| 2026-10-30 | v2.1.314 | VSCode：修复计划预览标签页 Cmd+F/Ctrl+F 不开查找 | R314 | [VSCode] Fixed Cmd+F / Ctrl+F not opening the find widget in the plan preview tab |
| 2026-10-30 | v2.1.314 | VSCode：修复非拉丁键盘（俄/希/希伯来）下听写快捷键 Ctrl+D 无效 | R314 | [VSCode] Fixed the voice dictation shortcut (Ctrl+D) doing nothing under non-Latin keyboard layouts |
| 2026-10-30 | v2.1.314 | VSCode：扩展无聊天打开时不再不问就删错过的单次定时任务 | R314 | [VSCode] Fixed missed one-time saved scheduled tasks being deleted without asking |
| 2026-10-30 | v2.1.314 | VSCode：CLAUDE_CODE_DISABLE_CFC_PROMPT 同时阻止注入 Chrome 使用说明（浏览器工具保留） | R314 | [VSCode] Changed `CLAUDE_CODE_DISABLE_CFC_PROMPT` to also stop the extension adding the Claude in Chrome instructions |
| 2026-10-30 | v2.1.314 | 云会话：Scheduled tasks 页加 Include completed 按钮 | R314 | [Cloud sessions] Added an Include completed button to the Scheduled tasks page |
| 2026-10-30 | v2.1.314 | 云会话：修复最近用过的自托管环境不出现在新建卡片 | R314 | [Cloud sessions] Fixed recently used self-hosted environments never appearing among the recent environments |
| 2026-10-30 | v2.1.314 | 云会话：修复 Claude 从别的 worktree 推 commit 后每轮误报未提交变更 | R314 | [Cloud sessions] Fixed cloud sessions reporting uncommitted changes every turn after Claude moved a branch to a commit it had pushed |
| 2026-10-30 | v2.1.314 | 云会话：修复自托管环境详情对话框在矮窗口/高缩放下挤出视区（可滚动） | R314 | [Cloud sessions] Fixed the self-hosted environment details dialog in admin settings squeezing its content out of view |
| 2026-10-30 | v2.1.314 | 云会话：切换权限模式被拒后选择器不再停在 Auto（显示实际模式） | R314 | [Cloud sessions] Fixed the permission mode picker staying on Auto after a running cloud or Remote Control session refused the switch |
| 2026-10-30 | v2.1.314 | 云会话：Anthropic 云端 scheduled 任务运行时加载 claude.ai 账号启用的插件 | R314 | [Cloud sessions] Improved scheduled tasks: runs in Anthropic's cloud now load the plugins enabled on your claude.ai account |
| 2026-10-30 | v2.1.314 | 云会话：GHE 测试连接同时按云会话方式再测一遍并警告第二次失败 | R314 | [Cloud sessions] Improved Test connection for GitHub Enterprise in admin settings to also connect the way cloud sessions do |
| 2026-10-30 | v2.1.314 | 云会话：转录重命名行显示新标题，仓库/环境列表表格化 | R314 | [Cloud sessions] Improved cloud session transcripts: a rename row now names the new title |
| 2026-10-30 | v2.1.314 | 云会话：setup 脚本报错也照常启动（不再启动失败） | R314 | [Cloud sessions] Changed cloud sessions from the web, desktop and mobile apps to start even when a setup script exits with an error |
| 2026-10-30 | v2.1.314 | Remote Control：修复权限模式按钮在键入前显示错模式 | R314 | [Remote Control] Fixed the permission mode button in Remote Control sessions showing the wrong mode until you typed |
| 2026-10-30 | v2.1.314 | Claude Tag：管理设置 Bundles/Channels 加 API 文档链接（可关） | R314 | [Claude Tag] Added a dismissible link to the Claude Tag API docs |
| 2026-10-30 | v2.1.314 | Claude Tag：跨 Grid 工作区频道 @Claude !restart 失败后重试再请重跑 | R314 | [Claude Tag] Fixed `@Claude !restart` giving up after one failed workspace check |
| 2026-10-30 | v2.1.314 | Claude Tag：同链接几分钟内连两次不再重复确认 DM 与频道说明 | R314 | [Claude Tag] Fixed a second confirmation DM and channel note when you connect your Claude account from Slack twice |
| 2026-10-30 | v2.1.314 | Claude Tag：等自托管 runner 时在跟帖发等待通知 | R314 | [Claude Tag] Fixed follow-up messages in Slack showing no sign of progress while Claude's session waits for a self-hosted runner |
| 2026-10-30 | v2.1.314 | Claude Tag：双组织都装了 Claude 的 Slack Connect 频道内自己线程的 @ 不再漏答 | R314 | [Claude Tag] Fixed Claude sometimes not answering a tag in its own thread in Slack Connect channels |
| 2026-10-30 | v2.1.314 | Claude Tag：插件/技能页 Retry 不再丢未保存的访问改动 | R314 | [Claude Tag] Fixed Retry on plugin and skill pages in Claude Tag admin settings discarding unsaved access changes |
| 2026-10-30 | v2.1.314 | Claude Tag：仓库控件菜单不再重复列已有动作 | R314 | [Claude Tag] Fixed the repositories control in Claude Tag admin settings showing the same action twice |

### 3.4 v2.1.315（2026-10-30，仅 npm）— 0 条可列

npm registry 显示 2.1.315 于 2026-10-30T21:05:24.080Z 发布；GitHub releases 无该 tag，CHANGELOG.md 无该章节。**无任何公开变更说明可引**，详见第 4 节。

### 3.5 v2.1.316（2026-10-31）— 55 条

出处列：`R316` = https://github.com/anthropics/claude-code/releases/tag/v2.1.316 。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-10-31 | v2.1.316 | 新增 CLAUDE_CODE_DISABLE_ULTRATHINK 关闭 ultrathink 关键字 | R316 | Added `CLAUDE_CODE_DISABLE_ULTRATHINK`, which turns the `ultrathink` keyword off |
| 2026-10-31 | v2.1.316 | 网关新增组共享月度预算（pooled_budget，在成员个人限额之上） | R316 | Added pooled group budgets to the Claude apps gateway: one monthly budget that a group's members share |
| 2026-10-31 | v2.1.316 | 新增 CLAUDE_CODE_DISABLE_LOOPED_CROSS_CERT_DROP 保留环形互证证书 | R316 | Added `CLAUDE_CODE_DISABLE_LOOPED_CROSS_CERT_DROP` to keep system cross-certificates that certify each other in a loop |
| 2026-10-31 | v2.1.316 | 新增 CLAUDE_CODE_SUBAGENT_EFFORT 设子代理默认 effort | R316 | Added `CLAUDE_CODE_SUBAGENT_EFFORT` to set the effort level subagents run at |
| 2026-10-31 | v2.1.316 | 网关新增 managed.policy_mode: layered（多条命中策略叠加合并） | R316 | Added `managed.policy_mode: layered` to the Claude apps gateway |
| 2026-10-31 | v2.1.316 | 网关 Bedrock 上游新增 guardrail.input_tagging（按护栏需要包裹 prompt 标签） | R316 | Added `guardrail.input_tagging` on Claude apps gateway Bedrock upstreams |
| 2026-10-31 | v2.1.316 | 弃用公告：Opus 4.8 fast mode 自 2026-10-30 弃用、2026-11-30 移除，迁移 Opus 5.5 | R316 | Deprecated fast mode for Opus 4.8 as of October 30, 2026; it will be removed on November 30, 2026 |
| 2026-10-31 | v2.1.316 | 修复自行退出（凭据被拒/云会话归档等）时 macOS/Linux 残留运行中的 shell 命令 | R316 | Fixed shell commands being left running on macOS and Linux when Claude Code exits by itself |
| 2026-10-31 | v2.1.316 | 修复带换行的 bash 别名与短横线开头函数名在 Bash 工具 shell 中损坏 | R316 | Fixed bash aliases with line breaks in their value… and functions whose names start with a dash, being garbled or lost |
| 2026-10-31 | v2.1.316 | 修复导出 SHELLOPTS 时 Bash 起的脚本只跑第一条命令 | R316 | Fixed bash scripts started from the Bash tool stopping after their first command when `SHELLOPTS` is exported |
| 2026-10-31 | v2.1.316 | 修复 PowerShell 钩子命令以类型转换/param/using/属性开头时退出码 2 不拦截 | R316 | Fixed PowerShell hooks not blocking on exit code 2 when the command begins with a type cast, `param`, `using` or an attribute |
| 2026-10-31 | v2.1.316 | 修复压缩响应被截断/损坏时部分网络请求挂起 | R316 | Fixed some network requests hanging when a compressed response was cut off or corrupted |
| 2026-10-31 | v2.1.316 | 修复 Vertex/Bedrock 上 sonnet/opus/haiku 新模型不可用时 mid-session 报错而非切旧模型 | R316 | Fixed `sonnet`, `opus` and `haiku` on Vertex AI and Amazon Bedrock showing an error mid-session instead of switching to an older model |
| 2026-10-31 | v2.1.316 | 网关补查请求点名的每个模型对 availableModels/deniedModels/models，违者 400 并指明字段 | R316 | Fixed the Claude apps gateway not checking every model a request names against `availableModels`, `deniedModels` and `models` |
| 2026-10-31 | v2.1.316 | 修复托管设置强制网关处 claude auth login 拒跑（现显示网关登录） | R316 | Fixed `claude auth login` refusing to run where managed settings require a Claude apps gateway |
| 2026-10-31 | v2.1.316 | 修复 --restricted 会话借 Read 白名单上传工作目录外文件 | R316 | Fixed `--restricted` sessions uploading files from outside the working directories when a Read allow rule covered them |
| 2026-10-31 | v2.1.316 | 修复含不可见字符的提示要按第二次回车（普通提示首回车即发） | R316 | Fixed prompts containing invisible characters needing a second Enter to send |
| 2026-10-31 | v2.1.316 | 修复继承父子代理模型的子代理被唤醒后漂移回主模型 | R316 | Fixed sub-agents that inherited a parent sub-agent's model moving to the main model when a background job or message woke them |
| 2026-10-31 | v2.1.316 | 修复无 "$defaults" 的托管 autoMode.allow 列表经 --settings//permissions/auto-mode-setup 找回内建例外 | R316 | Fixed a managed `autoMode.allow` list without `"$defaults"` getting the built-in exceptions back |
| 2026-10-31 | v2.1.316 | 修复 auto 模式因服务端无安全判定停轮时云会话/云定时任务未标失败 | R316 | Fixed cloud sessions and cloud scheduled tasks not being marked as failed when auto mode stopped a turn |
| 2026-10-31 | v2.1.316 | 修复后台代理运行中 claude -p 文本输出不说明 auto 停轮原因 | R316 | Fixed `claude -p` text output sometimes not saying why auto mode stopped a turn when a background agent was still running |
| 2026-10-31 | v2.1.316 | 修复代理/网关后宿主应用起的会话忽略 CLAUDE_CODE_AUTO_MODE_SERVER=1 | R316 | Fixed `CLAUDE_CODE_AUTO_MODE_SERVER=1` being ignored in sessions started by a host application… behind a proxy or LLM gateway |
| 2026-10-31 | v2.1.316 | 修复凭据同名环境变量设为开关值时插件 MCP headersHelper 收到损坏的 CLAUDE_PLUGIN_ROOT | R316 | Fixed plugin MCP `headersHelper` scripts receiving a corrupted `CLAUDE_PLUGIN_ROOT` and server URL |
| 2026-10-31 | v2.1.316 | 修复 SDK register_repo_root 不加载工作目录外的 CLAUDE.md（配合附加目录开关） | R316 | Fixed the SDK `register_repo_root` control request not loading the CLAUDE.md of a directory outside the working directory |
| 2026-10-31 | v2.1.316 | 修复 Artifact 工具对 self 层 artifact 数据库规则显示 ? 且拒重发布时不回引规则 | R316 | Fixed the Artifact tool showing `?` for artifact database access rules at the `self` level |
| 2026-10-31 | v2.1.316 | /model <id> 未识别时警告并说明自动压缩将按 200K 窗口假设 | R316 | Fixed `/model <id>` not warning when the model isn't recognized by this version and auto-compact will assume a 200K context window |
| 2026-10-31 | v2.1.316 | 修复「按住空格说话」提示一次会话内耗尽三次、未绑键时显示空键位 | R316 | Fixed the "hold space to speak" hint using up its three showings in one session |
| 2026-10-31 | v2.1.316 | 修复搜索进程超时被杀但不退出时 Grep/Glob 永不返回（Windows） | R316 | Fixed Grep and Glob never returning when the search process is killed at the timeout but does not exit, seen on Windows |
| 2026-10-31 | v2.1.316 | 修复 /clear 或 /resume 在会话还在保存时执行导致恢复不还原计划 | R316 | Fixed a rare case where resuming a conversation did not restore its plan |
| 2026-10-31 | v2.1.316 | 修复窄终端首启安全说明与终端设置说明掉字 | R316 | Fixed first-run setup dropping words from the security notes and the terminal-setup explanation in narrow terminals |
| 2026-10-31 | v2.1.316 | 修复企业调查卡短暂停顿后误收键入的 1/0（现需回车） | R316 | Fixed the Enterprise survey card taking a typed 1 or 0 after a short pause |
| 2026-10-31 | v2.1.316 | runner：进程被替换后 Stop 时收到的工作中消息又被答 | R316 | Self-hosted runner: Fixed a message sent while Claude was working being answered after a Stop |
| 2026-10-31 | v2.1.316 | runner：会话迁机后偶发丢 MCP 开关 | R316 | Self-hosted runner: Fixed an MCP server's on/off switch sometimes being lost when a session moved to a new machine |
| 2026-10-31 | v2.1.316 | Windows：修复 Git Bash rc 设 errexit/pipefail 且只定义 winpty 别名（或没有）时 Bash 工具丢别名/函数 | R316 | Windows: Fixed the Bash tool losing your aliases and functions in Git Bash when the rc file sets errexit and pipefail |
| 2026-10-31 | v2.1.316 | Code 标签页/web 发起的 /code-review：云与 RC 会话显示 findings 卡片而非纯文本列表 | R316 | Improved `/code-review` started from the Code tab in Claude Desktop or on the web |
| 2026-10-31 | v2.1.316 | 大仓库 /diff：每次刷新少一次全仓 git 命令，git 慢时刷新间隔拉开 | R316 | Improved `/diff` on large repositories: each refresh usually runs one fewer full-repository git command |
| 2026-10-31 | v2.1.316 | /ultrareview 等找不到 GitHub remote 的提示改为指引 github.com/new，不再给 gh 会拒的命令 | R316 | Improved the messages shown when `/ultrareview`, a cloud session or a cloud agent finds no GitHub remote |
| 2026-10-31 | v2.1.316 | SSL 证书错误点名可能原因（缺中间证书等）与修法 | R316 | Improved SSL certificate errors to name the likely causes |
| 2026-10-31 | v2.1.316 | auto 模式：无 "$defaults" 的 allow 列表不再移除定时任务提示的内建规则 | R316 | Changed auto mode so that an `autoMode.allow` list without `"$defaults"` no longer removes the built-in rule on scheduled-task prompts |
| 2026-10-31 | v2.1.316 | Team/Enterprise 服务端托管设置改为直接生效免批准；未过校验的存副本拒用 | R316 | Changed server-managed settings for Team and Enterprise logins: settings fetched from Anthropic's API now apply without an approval prompt |
| 2026-10-31 | v2.1.316 | VSCode：聊天面板直接登录 Claude apps gateway（无需终端） | R316 | [VSCode] Added sign-in to a Claude apps gateway from the chat panel |
| 2026-10-31 | v2.1.316 | VSCode：ultrathink 改为 xhigh 执行并在聊天框显示彩虹（与终端一致） | R316 | [VSCode] Changed `ultrathink` to run its turn at `xhigh` effort and show in a rainbow in the chat box |
| 2026-10-31 | v2.1.316 | VSCode：修复模型带 [1m] 标签时缺 Effort 滑杆、Ultracode 开关与模型名 | R316 | [VSCode] Fixed the missing Effort slider, Ultracode switch and model name when the model setting has the `[1m]` tag |
| 2026-10-31 | v2.1.316 | VSCode：修复设置文件有错时过早删 /btw 历史记录 | R316 | [VSCode] Fixed saved `/btw` side-question history being deleted too early while a settings file has errors |
| 2026-10-31 | v2.1.316 | VSCode：修复计划以「手动批准编辑」通过后重载/重启会话回到 Auto 模式 | R316 | [VSCode] Fixed a conversation coming back in Auto mode after a reload or restart |
| 2026-10-31 | v2.1.316 | 云会话：新增表单卡片——MCP 服务器要的表单可填写或拒绝（原直接取消） | R316 | [Cloud sessions] Added a form card to cloud sessions, so you can fill in or decline a form an MCP server asks for |
| 2026-10-31 | v2.1.316 | 云会话：切回还在同步的云/RC 会话时显示 "Catching up…" | R316 | [Cloud sessions] Added a "Catching up…" line |
| 2026-10-31 | v2.1.316 | 云会话：Enterprise 成员可在自己的云环境上自行增删网络密钥 | R316 | [Cloud sessions] Changed network secrets so Enterprise members can add and delete them on their own cloud environments |
| 2026-10-31 | v2.1.316 | 云会话：Changes 面板的省略说明改为分支名旁徽标 | R316 | [Cloud sessions] Improved the Changes pane for cloud sessions: the note about what the list leaves out is now a badge |
| 2026-10-31 | v2.1.316 | 云会话：修复 Files 面板 cd 后文件夹显示 ../..（改从项目根起算路径） | R316 | [Cloud sessions] Fixed file search in a cloud session's Files pane showing folders as ../.. paths after Claude changed directory |
| 2026-10-31 | v2.1.316 | Claude Tag：画布被分享到其他频道/DM 后不再拒绝从原频道编辑 | R316 | [Claude Tag] Fixed Claude refusing to edit or append to a canvas it made in a Slack channel, from that channel |
| 2026-10-31 | v2.1.316 | Claude Tag：双组织装 Claude 的 Slack Connect 线程未 @ 的回复不再无人应 | R316 | [Claude Tag] Fixed untagged replies going unanswered in a Slack Connect thread |
| 2026-10-31 | v2.1.316 | Claude Tag：云定时任务 Slack 状态清单可被该轮编辑不再半途卡住 | R316 | [Claude Tag] Fixed a cloud scheduled task's live status checklist in Slack staying half-done |
| 2026-10-31 | v2.1.316 | Claude Tag：频道的 Respond automatically 开关改为「How Claude participates」选项 | R316 | [Claude Tag] Changed a Slack channel's Respond automatically switch to a "How Claude participates" choice |
| 2026-10-31 | v2.1.316 | Code Review 分析页新增按严重度 findings 卡（总数、按天堆叠图、各档计数） | R316 | [Code Review] Added a findings-by-severity card to the Code Review analytics page |

（计数自检：本表 55 条与 CHANGELOG.md 该章节 55 个条目逐一致，用 awk 按 "- " 行统计核对，见第 4 节第 10 条。）

### 3.6 v2.1.317（npm 2026-11-02T23:57:53Z ／ GH release 2026-11-03T01:25:46Z）— 87 条

出处列：`R317` = https://github.com/anthropics/claude-code/releases/tag/v2.1.317 。日期列按 npm 发布时间写 2026-11-02（窗口内），GH release 页日期 11-03，已在版本核实处标注分歧。

| 日期 | 版本 | 变化（一行中文） | 出处 | 原文短引 |
|---|---|---|---|---|
| 2026-11-02 | v2.1.317 | /schedule 对新云定时任务混入未请求连接器时警告并给移除方法 | R317 | Added a warning to `/schedule` when a new cloud scheduled task gets connectors you did not ask for |
| 2026-11-02 | v2.1.317 | web/shell 工具调用要把账号邮箱发上网前先征得同意 | R317 | Added a check that asks before a web or shell tool call sends your account email address to the network |
| 2026-11-02 | v2.1.317 | Agent SDK 钩子回调支持 onFailure: "block"（回调失败即拦截动作） | R317 | Added `onFailure: "block"` for Agent SDK hook callbacks |
| 2026-11-02 | v2.1.317 | 桌面 Code 标签页提示组织远程托管设置未加载/已加载 | R317 | Added a notice in Claude Desktop's Code tab when your organization's remote managed settings haven't loaded |
| 2026-11-02 | v2.1.317 | auto 模式对子代理工具调用无答案时给提示（原主视图空白） | R317 | Added a notice when auto mode's check has no answer for a subagent's tool call |
| 2026-11-02 | v2.1.317 | OTel 指标/事件/span 增加 anthropic.plan/seat_type/provider/custom_base_url | R317 | Added `anthropic.plan`, `anthropic.seat_type`, `anthropic.provider` and `anthropic.custom_base_url` to OTel metrics |
| 2026-11-02 | v2.1.317 | 网关管理 API 新增成本报表 GET /v1/organizations/analytics/cost（总/按开发者/按天/按 IdP 组） | R317 | Added a cost report to the Claude apps gateway admin API, `GET /v1/organizations/analytics/cost` |
| 2026-11-02 | v2.1.317 | 网关按天记录开发者 IdP 组（admin.identity_retention_days），供成本报表分组 | R317 | Added a daily record of each developer's IdP groups on Claude apps gateways with `admin:` set |
| 2026-11-02 | v2.1.317 | 新增 CLAUDE_CODE_DISABLE_NESTED_SESSION_ID：runner 内 claude -p 沿用所在会话 ID 与转录 | R317 | Added `CLAUDE_CODE_DISABLE_NESTED_SESSION_ID`: set it to `1` on a self-hosted runner |
| 2026-11-02 | v2.1.317 | 修复部分桌面会话首轮后项目/本地 MCP 服务器断连 | R317 | Fixed project and local MCP servers disconnecting after the first turn in some Claude desktop sessions |
| 2026-11-02 | v2.1.317 | 修复 LLM 网关对安全检查回 403/422 时 auto 模式轮轮失败（403+apiKeyHelper 情形不变） | R317 | Fixed auto mode failing every turn when an LLM gateway set as the base URL answers 403 or 422 to its server-side safety check |
| 2026-11-02 | v2.1.317 | 修复 claude auth status 在慢令牌刷新存盘前退出（可能下次被登出） | R317 | Fixed `claude auth status` exiting before a slow token refresh was saved |
| 2026-11-02 | v2.1.317 | 修复桌面 Code 标签页等宿主预开的会话忽略项目 effortLevel | R317 | Fixed a project's `effortLevel` setting being ignored by sessions that an app starts ahead of time |
| 2026-11-02 | v2.1.317 | 修复多会话项目里 claude --from-pr 报 No conversations found（目标会话在第一页之外） | R317 | Fixed `claude --from-pr` reporting "No conversations found" in projects with many sessions |
| 2026-11-02 | v2.1.317 | 修复 claude.ai/移动端两个并发权限弹窗第二个不显示文件路径与命令 | R317 | Fixed the second of two simultaneous permission prompts showing no file path or command |
| 2026-11-02 | v2.1.317 | 修复 RC 与 SDK 宿主对 mod 工具调用提供 don't ask again | R317 | Fixed Remote Control and SDK hosts offering "don't ask again" on a mod's tool calls |
| 2026-11-02 | v2.1.317 | 修复云/SDK 会话在标题生成中来新消息或 Stop 时丢标题 | R317 | Fixed session titles being lost in cloud and SDK sessions when a new message or Stop arrived |
| 2026-11-02 | v2.1.317 | 修复 /loop 自步进唤醒偶发漏排 | R317 | Fixed self-paced `/loop` wakeups sometimes not being scheduled |
| 2026-11-02 | v2.1.317 | 修复云会话 auto 模式在 Artifact 上传/写库/存 outputs 时误停轮等批准 | R317 | Fixed auto mode in cloud sessions stopping for approval when the Artifact tool uploaded, wrote to a database or saved a file |
| 2026-11-02 | v2.1.317 | 修复 claude.ai 同步技能不可写时每 10 分钟丢失/重下 | R317 | Fixed skills synced from claude.ai being lost or downloaded again every ten minutes when they can't be written to disk |
| 2026-11-02 | v2.1.317 | 修复 /schedule 创建/更新后结果缺下次运行时间与链接 | R317 | Fixed `/schedule` leaving a cloud scheduled task's next run time and link out of its results |
| 2026-11-02 | v2.1.317 | 修复读屏模式每次变化都播报子代理耗时与 token 数 | R317 | Fixed screen readers speaking a running subagent's elapsed time and token count on every change |
| 2026-11-02 | v2.1.317 | 修复地区/网络封锁（HTTP 403）被显示成登录失败（现说明封锁） | R317 | Fixed a region or network block (HTTP 403) being shown as a sign-in failure; the error now explains the block |
| 2026-11-02 | v2.1.317 | 修复云会话把正常 claude.ai 连接器误报需授权/失败（同步插件含同名服务器时） | R317 | Fixed Claude saying a working claude.ai connector needed authorization or had failed in cloud sessions |
| 2026-11-02 | v2.1.317 | 修复磁盘满/配额丢转录或 ~/.claude.json 写入时 claude -p 仍退出 0（现报错退出 1） | R317 | Fixed `claude -p` exiting 0 when a full disk or quota lost its transcript or ~/.claude.json writes |
| 2026-11-02 | v2.1.317 | 修复启动后约 1 秒内改设置文件不生效（直到下次再改） | R317 | Fixed edits to settings files made in the first second or so after launch not taking effect |
| 2026-11-02 | v2.1.317 | 修复 --setting-sources 等跳过清理的机器上旧转录不清理 | R317 | Fixed old transcripts not being cleaned up on machines where some runs skip cleanup |
| 2026-11-02 | v2.1.317 | 修复队友迟来消息重建已删 agent 团队收件箱 | R317 | Fixed deleted agent team inboxes being re-created by a teammate's late message |
| 2026-11-02 | v2.1.317 | 修复重建的 agent 队友被更早的关闭批准移出团队 | R317 | Fixed a re-created agent teammate being removed from its team by an earlier shutdown approval |
| 2026-11-02 | v2.1.317 | 修复定时任务关闭后存储任务无法列出/删除 | R317 | Fixed stored scheduled tasks being impossible to list or delete after scheduled tasks were turned off |
| 2026-11-02 | v2.1.317 | 修复让删「某个」/team-onboarding 指南时误删最近更新的那个 | R317 | Fixed Claude deleting your most recently updated `/team-onboarding` guide when asked to delete one without naming which |
| 2026-11-02 | v2.1.317 | 修复服务端拒删时谎报 /team-onboarding 指南已删除 | R317 | Fixed Claude saying a `/team-onboarding` guide was deleted when the server refused the delete |
| 2026-11-02 | v2.1.317 | 修复网关吞掉 Bedrock「Input is too long.」致轮轮失败（现正常压缩） | R317 | Fixed the Claude apps gateway hiding Amazon Bedrock's "Input is too long." error |
| 2026-11-02 | v2.1.317 | 修复 runner 会话在计划等批准时重启丢近期轮次/整段对话 | R317 | Fixed self-hosted runner sessions losing recent turns or the whole conversation when restarted while a plan waited for approval |
| 2026-11-02 | v2.1.317 | 修复超大 CLAUDE.md 变更后自动压缩报 Prompt is too long | R317 | Fixed "Prompt is too long" after automatic compaction in sessions whose very large CLAUDE.md changed since it was last sent |
| 2026-11-02 | v2.1.317 | 修复注册大量命令插件的无头会话高内存、慢启动 | R317 | Fixed high memory use and slow startup in headless sessions with many plugins that register commands |
| 2026-11-02 | v2.1.317 | 修复 stdio MCP 的 AWS_BEARER_TOKEN_BEDROCK 设空时收到空串（现不设，让服务器用机器自身凭据） | R317 | Fixed stdio MCP servers receiving an empty `AWS_BEARER_TOKEN_BEDROCK` when their env config sets it to empty |
| 2026-11-02 | v2.1.317 | 修复根证书更新后 TLS 检查代理后报 unable to get local issuer certificate | R317 | Fixed API requests failing with "unable to get local issuer certificate" behind some TLS-inspecting proxies |
| 2026-11-02 | v2.1.317 | 修复超长对话压缩请求自己被裁时丢先前摘要 | R317 | Fixed very long conversations losing their earlier summary when compaction had to shorten its own request |
| 2026-11-02 | v2.1.317 | 修复 PDF 自带元数据让 Read/@提及少数页数 | R317 | Fixed a PDF's own metadata being able to make Read and @-mentions under-count its pages |
| 2026-11-02 | v2.1.317 | 修复 DISABLE_PROMPT_CACHING_OPUS/SONNET 对 [1m]、其他地区与无日期拼写默认模型无效 | R317 | Fixed `DISABLE_PROMPT_CACHING_OPUS` and `DISABLE_PROMPT_CACHING_SONNET` having no effect on `[1m]`, other-region and undated spellings |
| 2026-11-02 | v2.1.317 | 修复自有产物 ≥200 时 /artifacts 与 Artifact 工具不显示共享产物 | R317 | Fixed `/artifacts` and the Artifact tool's shared list showing no shared artifacts when you have 200 or more of your own |
| 2026-11-02 | v2.1.317 | 修复搜索超时后把部分 Grep/Glob 结果当完整 | R317 | Fixed Claude treating partial Grep and Glob results as complete when a search hit its time limit |
| 2026-11-02 | v2.1.317 | 修复 https OTel 导出经代理在另一导出进行中启动时永不发送 | R317 | Fixed OpenTelemetry exports to an `https://` endpoint through a proxy never being sent |
| 2026-11-02 | v2.1.317 | 修复封 403 的代理对 http OTel 导出的连接风暴 | R317 | Fixed a flood of connection attempts to a proxy that blocks (HTTP 403) OpenTelemetry exports |
| 2026-11-02 | v2.1.317 | 修复 OTel 导出在不应答代理后无限挂起（10 秒超时，可 OTEL_EXPORTER_OTLP_TIMEOUT 至 30 秒） | R317 | Fixed OpenTelemetry exports hanging indefinitely behind a proxy that never answers |
| 2026-11-02 | v2.1.317 | 修复恢复的会话向 Claude 重复告知已知文件变更 | R317 | Fixed resumed sessions telling Claude again about a file change it already knew about |
| 2026-11-02 | v2.1.317 | 修复上次调用因工具被关失败后恢复会话不再用内建工具 | R317 | Fixed Claude sometimes not using a built-in tool in a resumed session after an earlier call failed |
| 2026-11-02 | v2.1.317 | 修复 disableRemoteControl 关闭时 /remote-control 答 Unknown command（现说明被关） | R317 | Fixed `/remote-control` answering "Unknown command" instead of saying that Remote Control is turned off |
| 2026-11-02 | v2.1.317 | 修复 tmux/iTerm2 面板里队友在 lead 为手动模式时仍进 auto 模式 | R317 | Fixed agent team teammates in tmux or iTerm2 panes starting in auto mode when the lead session was in manual mode |
| 2026-11-02 | v2.1.317 | 修复后台会话升级/退役时刚改的权限模式丢失 | R317 | Fixed a background session sometimes losing a just-made change of permission mode when it was upgraded or retired |
| 2026-11-02 | v2.1.317 | 修复提示符 Ctrl+C 清字时误停全部后台代理 | R317 | Fixed Ctrl+C stopping all running background agents when pressed to clear typed text at the prompt |
| 2026-11-02 | v2.1.317 | 修复 /feedback 发送中仍显示 Enter to confirm | R317 | Fixed /feedback showing "Enter to confirm" while a report is being sent |
| 2026-11-02 | v2.1.317 | 修复停掉 shell 命令的子进程被发两次 SIGTERM（部分程序跳过清理） | R317 | Fixed child processes of a stopped shell command sometimes being sent SIGTERM twice |
| 2026-11-02 | v2.1.317 | 修复云/runner 会话内 claude -p 共享会话 ID 写入该会话转录、重启可能续错会话 | R317 | Fixed `claude -p` run inside a cloud or self-hosted runner session sharing that session's ID |
| 2026-11-02 | v2.1.317 | 修复云/runner 会话内 claude -p 自起标题发给该会话 | R317 | Fixed `claude -p` run inside a cloud or self-hosted runner session generating a title of its own |
| 2026-11-02 | v2.1.317 | 改进 Microsoft Foundry Azure 凭据加载失败报错（cloud_credential_error） | R317 | Improved the error shown on Microsoft Foundry when Azure credentials can't be loaded |
| 2026-11-02 | v2.1.317 | /design-sync 先提示设计系统已迁 Claude 并停在建（原上传时失败） | R317 | Improved `/design-sync` to say up front when your design system has moved to Claude |
| 2026-11-02 | v2.1.317 | 网关连不上时启动报错指向网络而非登录，并说明 TLS 证书无法校验情形 | R317 | Improved the startup error when a required Claude apps gateway can't be reached |
| 2026-11-02 | v2.1.317 | 退出提示「Resume this session with」先重复启动 flags 再 --resume | R317 | Improved the "Resume this session with" hint shown at exit to repeat the flags you launched with |
| 2026-11-02 | v2.1.317 | runner：5xx（除 501/529）后下一轮轮询改开新连接 | R317 | Improved how self-hosted runners recover from server errors: after a 5xx other than 501 or 529 |
| 2026-11-02 | v2.1.317 | runner 会话：5xx 后改开新连接 | R317 | Improved how self-hosted runner sessions recover from server errors: after a 5xx other than 501 or 529 |
| 2026-11-02 | v2.1.317 | runner 会话：心跳无应答后改开新连接 | R317 | Improved how self-hosted runner sessions recover when connections stop answering |
| 2026-11-02 | v2.1.317 | SendMessage 给运行中后台代理的消息更早送达（命令转后台不停） | R317 | Changed SendMessage so a message to a running background agent arrives earlier |
| 2026-11-02 | v2.1.317 | 不同模型的子代理/队友改用该模型保存的 effort 档或默认值 | R317 | Changed subagents and teammates on a different model from the main conversation to use that model's saved effort level |
| 2026-11-02 | v2.1.317 | 退出时对插件监视器跳过「后台任务在跑」提示 | R317 | Changed exit to skip the "Background work is running" prompt for plugin monitors |
| 2026-11-02 | v2.1.317 | 内建 plugin-authoring 技能在 mod 可用后主动提议帮忙分享 | R317 | Changed the built-in `plugin-authoring` skill to offer once, after a mod you built works, to help share the mod |
| 2026-11-02 | v2.1.317 | 移除 Read 工具「文件未变」占位：重读未变文件返回内容 | R317 | Removed the Read tool's "file unchanged since your last Read" stub |
| 2026-11-02 | v2.1.317 | Windows：修复部分卷上原生路径查找失败致全部工具调用被拒（改比目录身份） | R317 | Windows: Fixed every tool call being refused on some volumes where the native path lookup fails |
| 2026-11-02 | v2.1.317 | Windows：修复非桌面启动会话的暂存路径随项目路径增长撞 260 字符限制 | R317 | Windows: Fixed the session scratchpad and other temporary paths growing with your project's path length |
| 2026-11-02 | v2.1.317 | 网关：修复组池预算用尽后状态行与 /usage 把个人限额显示成 100% 用尽 | R317 | Gateway: Fixed the status line and `/usage` showing a developer's own spend limit as 100% used |
| 2026-11-02 | v2.1.317 | runner：会话迁机后超龄中断轮次不可见 | R317 | Self-hosted runner: Fixed Claude not seeing the interrupted tool call when a session moves to a new runner |
| 2026-11-02 | v2.1.317 | runner：修复会话服务拒存时迁机后 MCP 服务器复活 | R317 | Self-hosted runner: Fixed an MCP server that was switched off coming back on after the session moved to a new machine |
| 2026-11-02 | v2.1.317 | Remote Control：应用未设名时 fork 命名改进（保留 (fork) 结尾、(fork 2)） | R317 | Remote Control: Improved fork names when the app doesn't set one |
| 2026-11-02 | v2.1.317 | VSCode：修复分叉对话丢消息（并行工具调用只留其一、压缩尾消息丢失） | R317 | [VSCode] Fixed forked conversations dropping messages: only one of the tool calls Claude ran in parallel was kept |
| 2026-11-02 | v2.1.317 | VSCode：修复 Claude 未按时启动即丢消息（现先再启动一次） | R317 | [VSCode] Fixed a message being lost when Claude did not finish starting in time |
| 2026-11-02 | v2.1.317 | VSCode：区域/网络被封锁时不再开登录屏 | R317 | [VSCode] Fixed the sign-in screen opening when a request is blocked for its region or network |
| 2026-11-02 | v2.1.317 | VSCode：修复账户面板套餐名第二词小写 | R317 | [VSCode] Fixed the Account panel showing the plan name with a lower-cased second word |
| 2026-11-02 | v2.1.317 | VSCode：修复 Claude 标签内文件链接开在聊天上方而非另一编辑组 | R317 | [VSCode] Fixed file links in a Claude tab opening on top of the chat instead of in another editor group |
| 2026-11-02 | v2.1.317 | VSCode：修复 chat.fontSize 调大时附件芯片/菜单/横幅/对话框不放大 | R317 | [VSCode] Fixed attachment chips, menus, banners and dialogs in the Claude panel staying small |
| 2026-11-02 | v2.1.317 | VSCode：修复遥测关闭时 ultrathink 不提效也不显示彩虹 | R317 | [VSCode] Fixed `ultrathink` not raising effort for its turn or showing its rainbow when telemetry is off |
| 2026-11-02 | v2.1.317 | 云会话：新增链接卡片——MCP 请求访问的链接可打开或拒绝 | R317 | [Cloud sessions] Added a link card to cloud sessions, so you can open or decline a link an MCP server asks you to visit |
| 2026-11-02 | v2.1.317 | 云会话：管理设置组织环境对话框改个人对话框紧凑布局 | R317 | [Cloud sessions] Changed the organization environment dialog in admin settings to the personal dialogs' short layout |
| 2026-11-02 | v2.1.317 | 云会话：已有密钥主机再加网络密钥不再静默替换（拒绝并指向既有密钥） | R317 | [Cloud sessions] Fixed adding a network secret for a host that already has one silently replacing it |
| 2026-11-02 | v2.1.317 | 云会话：新建定时任务遵循组织默认环境 | R317 | [Cloud sessions] Fixed new scheduled tasks ignoring your organization's default environment |
| 2026-11-02 | v2.1.317 | Remote Control：重启 claude remote-control 后一分钟内发来的下一条消息不再无人应 | R317 | [Remote Control] Fixed the next message to an idle session going unanswered after you restart `claude remote-control` |
| 2026-11-02 | v2.1.317 | Claude Tag：Slack 新贴 artifact 链接改简洁卡片+Open（开进 Claude，不再 Slack 侧栏） | R317 | [Claude Tag] Changed newly pasted artifact links in Slack to show a simpler card with an Open button |

---

## 4. 拿不到 / 无法核实的

1. **claude-code v2.1.315 的变更内容**：npm registry 证实该版本 2026-10-30T21:05:24.080Z 发布（窗口内），但 anthropics/claude-code 的 GitHub releases 无 v2.1.315 tag、CHANGELOG.md 无对应章节。**该版本发了什么无法核实**，不编条目。可能为空发布/重发布，无法确认。
2. **claude-code v2.1.317 的窗口归属**：npm 发布 2026-11-02T23:57:53Z（窗口内，距 23:59:59Z 边界 2 分钟），GitHub release 页 2026-11-03T01:25:46Z（窗口外）。两个口径都如实列出；若比对报告按「GH release 页日期」口径，则 3.6 节整节应移出窗口。
3. **Memoh v1.0.0**：tag 存在（指向 2026-11-01T22:48:34Z 的 commit `9a4f1b92`），无 GitHub Release 页与 notes。其与 v1.0.1（23:08:38Z release commit）之间只有约 20 分钟，**未发现独立于 v1.0.1 的变化**；对外发布以 v1.0.1 计。
4. **Memoh #1727**（2026-11-02T13:56:29Z 合入）：在窗口内、v1.0.1 之后，截至采集时**未随任何发布版本**发出，只能引 PR 而无 release 页。
5. **dots 的日期粒度**：`learn.chatgpt.com/docs/whats-new` 的 digest 条目不带日期，dots 文档页也无「最后更新」时间戳；只有能对上 `/docs/changelog` 日期的条目给了日期（2.1 节），其余标「日期不明」（2.2 节）。**whats-new 首页各条目的发布日无法从页面本身核实**。
6. **help.openai.com**：403，未取到内容（任务书预期如此）。
7. **OpenAI 侧对应「支持页 release notes」**：未发现可达的等价物（learn.chatgpt.com/docs/changelog 为唯一带日期版本页，已用尽）。
8. **Codex CLI 0.166.0 / 0.165.0 的 Chores 段**（V8 源码构建、独立 executor 打包、Node 24.22.1/Rust 1.95.0 等）判为内部改动，未逐条列； changelog 原文里有，需要时可回溯 CL 页。
9. **Memoh PR 级合入日与发布日的归属**：窗口内两个版本包含少量 10-25 及更早合入的条目（已逐条标注）。若比对报告以「合入日」口径剔除这些条目，差异点即在此口径。
10. **条目计数自检**：写作过程中 3.5/3.6 的小标题计数一度写错（58/88），已用 `awk '/^- /'` 按 CHANGELOG.md 各章节实际条目数（311=92、312=39、314=119、316=55、317=87）逐一核对并改正；各表行数与权威计数一一相符。
11. **未读取盲测目录**：`~/work/competitor-archive/`、`~/work/code-agent-private-archive/docs/competitive/` 全程未打开、未搜索、未列目录。

---

## 5. 验收对照（逐条原文引用）

① 「三家（Memoh、OpenAI dots、Claude Code）在 2026-10-26～11-02 窗口内用户可见的变化逐条列出，每条带日期、出处链接和原文短引」——满足：第 1 节 Memoh 64 条、第 2 节 dots 窗口内 51 条+日期不明/窗口外 4 条、第 3 节 Claude Code 92+39+119+55+87 条，均带日期列、出处链接列与原文短引列；日期不明与拿不到的见第 4 节，未编造。
② 「证据档开头写明实际用了哪些联网工具、哪些失败（带报错）；拿不到的写明，不编版本号、日期和功能」——满足：第 0 节逐项列出工具与报错原文；第 4 节列明全部无法核实项。
③ 「未读取私档竞品目录（盲测，供与 11-02 周报逐条比对）」——满足：见文首盲测声明与第 4 节第 11 条。
④ 「预期收益：验证 Flash 能否承担竞品追踪的采集段，把 Claude 留给判断」——本轮以纯采集交付：三家全部第一手来源走通（Memoh 26 个窗口内 PR + 2 个 release 正文；dots 3 个官方文档页；claude-code CHANGELOG+releases+npm+支持页），未做任何判断性改写，逐条保留原文短引供比对。

---

## 6. 判断与取舍记录（无人值守，按任务书要求记录在此）

1. 未 rebase、未 commit、未 push：本单只读、无代码改动，HEAD 即分支现有 `64ba8ef3`；任务书施工环境一节的「rebase 用 git rebase origin/main」对纯采集单不适用，跳过。
2. 采集基准日期一律 UTC；窗口按 [2026-10-26T00:00:00Z, 2026-11-02T23:59:59Z] 闭区间。
3. Memoh 无仓库内 changelog → 以 GitHub Release notes 为真源；逐条出处给 Release 页（notes 内自带 PR 链接）。
4. Memoh 表格日期口径 = 发布日；合入日显著早于发布日的条目在行内标注，供两种口径比对。
5. #1717（refactor）与 #1722（chore）的取舍见第 1 节采集口径；#1717 判用户可见、#1722 判内部。
6. claude-code 章节日期以 GH release `published_at` 为主口径，npm 时间互校；v2.1.317 双口径分歧如实并列并按 npm 时间收录。
7. claude-code 变更「一行中文」尽量保留原文限定语（哪个平台、哪个开关、哪种条件），不合并、不省略范围词。
8. dots 侧把 ChatGPT/Codex 平台级窗口条目全收（dots 依托该面板），dots 专属条目单列并标「日期不明」；Codex CLI Chores 不列。
9. WebSearch 未使用：三家已知一手出口全部走通且互相印证，无需搜索旁证。
10. 环境约束遵守情况：未装依赖、未跑全仓检查、未动任何仓内文件；本轮无测试/门义务（纯只读采集）。原始抓取件已留档 `~/work/out/N-COMPETITOR-FLASH-PILOT/`。

DONE N-COMPETITOR-FLASH-PILOT 64ba8ef3


---

# 第 2 轮（返修交付）· 2026-11-06

## R2-0. 返修原因与本轮动作

- 队列判定第 1 轮「没交活」：证据档末行格式本身正确（`DONE N-COMPETITOR-FLASH-PILOT 64ba8ef3`），但分支比 origin/main 多 0 个提交、无未提交改动——收货检查把「分支上没有新 commit」视作未交付，原样退回；返修指令明确「请把活干完、提交、写 DONE 行」。
- 本轮动作：① `git rebase origin/main`（no-op，分支与 origin/main 同在 64ba8ef3）；② 对第 1 轮全部数据做独立复核（R2-1，全部一手源重新抓取，不复用第 1 轮快照当证据）；③ 把证据档快照提交进工作树分支（判断记录见 R2-3）；④ 提交后追加最终 DONE 行。

## R2-1. 第 1 轮数据独立复核（全部通过，无实质差异）

方法：fresh 抓取全部一手源，`python3 -I` 脚本把证据档 511 个数据行的「原文短引」逐行与其声称出处全文比对；抓取件与脚本输出存 `~/work/out/N-COMPETITOR-FLASH-PILOT/verify-r2/`。

| 复核项 | 结果 |
|---|---|
| Memoh releases 序列 | v0.22.0 2026-10-19（窗口前最后 stable）→ v1.0.0-beta.1 2026-10-27T02:09:07Z（prerelease）→ v1.0.1 2026-11-01T23:25:44Z（stable）；窗口内无其他 release |
| Memoh v1.0.0 | release 页 404；tag 存在，指向 commit 9a4f1b92（2026-11-01T22:48:34Z） |
| Memoh 窗口内合入 PR | search API total_count = 26；#1727 合入 2026-11-02T13:56:29Z（v1.0.1 之后、未随版）；#1717（refactor）、#1722（chore）标题与第 1 轮口径描述逐字一致 |
| Memoh 变化表 64 行 | 62 行 release-notes 行短引逐字命中对应 release body（仅 1 行为 `&lt;name&gt;` 实体编码差异，解码后一致）；2 行 PR 行（#1717/#1727）标题经 search API 逐字核对 |
| claude-code 版本与日期 | GH releases 窗口内：v2.1.311（10-26T21:51:23Z）、v2.1.312（10-27T20:24:20Z）、v2.1.314（10-30T01:06:26Z）、v2.1.316（10-31T01:01:35Z）、v2.1.317（11-03T01:25:46Z，GH 口径窗口外）；npm：311=10-26T19:47:57Z、312=10-27T18:36:10Z、314=10-30T00:12:56Z、315=10-30T21:05:24Z、316=10-31T00:42:05Z、317=11-02T23:57:53Z（窗口内）、318=11-03T21:55Z（窗口外）；2.1.313 三处均不存在（跳号）——与第 1 轮逐项一致 |
| claude-code CHANGELOG 计数 | fresh main 分支 CHANGELOG.md：311=92、312=39、314=119、316=55、317=87 条，与 3.1–3.6 各表行数逐一相符；313/315 无章节；318（84 条，11-03）与 319（11-06，本轮采集当日发布）在窗口外，未收录，正确 |
| claude-code 变化表 392 行 | 短引全部逐字命中 fresh CHANGELOG 对应章节 |
| support.claude.com release notes | 窗口内（10-26～11-02）确无条目；最近前一条 2026-10-21「Claude Duet research preview for Pro and Max plans」，最近后一条 2026-11-05「New security and admin controls for Enterprise plans / Personal Finance in Claude」——第 1 轮阴性发现成立 |
| dots changelog 完整性 | fresh 页面在窗口内的日期恰为 {2026-10-26, 10-27, 10-29, 11-02}，无 10-28/30/31、11-01 条目；各条目子项数：10-26 Terra 平台条目=1、iOS 1.2026.293=10、Codex CLI 0.165.0=12、Codex CLI 0.166.0=13、iOS 1.2026.300=14，与 2.1 节 51 行逐一对应；0.165.0/0.166.0 的 Chores 段（V8 源码构建、standalone executor 打包、Node 24.22.1/Rust 1.95.0）确在页面，第 1 轮判内部改动未列，口径一致 |
| dots 侧文档引用 | Terra 扩家族句、texting beta 句、Nov 18 生效句、1.2026.279 绑定句、手机建 dot 句全部逐字命中 fresh 页面 |
| 表行计数 | 变化表 64 + 2.1 节 51 + 2.2 节 4 + 3.1–3.6 节 92/39/119/55/87 = 511 行，与各节标题声称条数一致 |

复核发现的不一致：**无**（仅 `<name>` 一处实体编码书写差异，语义相同，不改第 1 轮正文）。

## R2-2. 本轮工具使用情况（第 0 节的追加）

| 工具 | 用途 | 结果 |
|---|---|---|
| `gh api`（GitHub REST） | Memoh releases/tags/PR search/commit；claude-code releases | 全部成功 |
| `curl` → raw.githubusercontent.com | fresh claude-code CHANGELOG.md | 成功（1,155,046 字节） |
| `curl` → learn.chatgpt.com（/docs/changelog、/docs/dots、/docs/whats-new，带浏览器 UA） | fresh HTML 三页（4.76MB / 0.49MB / 1.08MB） | 成功（第 1 轮因 WebFetch 超时改用 webReader；本轮 curl 直取即可） |
| WebFetch → support.claude.com release notes | 阴性复核 | 成功 |
| `npm view @anthropic-ai/claude-code time --json` | npm 发布时间复核 | 成功 |
| `curl` → help.openai.com | 复核任务书预期 | HTTP 403（与第 1 轮一致） |
| `python3 -I` 本地脚本（/tmp/ncfp-r2/） | 511 行短引逐行比对、changelog 条目结构化抽取 | 成功 |

本轮无新增失败项。

## R2-3. 判断与取舍（返修轮）

1. **commit 与任务书 Discipline 的冲突**：任务书 Discipline 写「do not commit」，但派单方返修指令明确「把活干完、提交、写 DONE 行」，且队列收货检查把「分支无新提交」判为未交付。取舍：执行派单方返修指令，提交**且仅提交**本证据档快照为根目录新文件 `N-COMPETITOR-FLASH-PILOT.md`——不修改任何既有仓内文件、不碰代码、不 push、不合并、不开 PR；与 Discipline「保持采集只读、不影响比对」的本意不冲突。此为无人值守下的现场取舍，如实记录于此。
2. **DONE 行的先后**：commit 的 sha 只有提交后才知道，故仓内快照不含最后一行 DONE（比证据档实况少且仅少这一行）；`~/work/evidence/N-COMPETITOR-FLASH-PILOT.md` 在提交后追加最终 DONE 行。
3. **盲测重申**：第 2 轮全程未读取、未列目录、未搜索 `~/work/competitor-archive/` 与 `~/work/code-agent-private-archive/docs/competitive/`；复核只用外部一手源。
4. 第 1 轮正文（第 0–6 节）保持原样未改，本轮只追加；本文件最后一行即收货行。
