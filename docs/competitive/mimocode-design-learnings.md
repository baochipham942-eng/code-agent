# MiMoCode 可借鉴设计深挖：UX / CLI / 多端架构 / Agent Runtime

> 日期：2026-06-11
> 续篇：六项核心能力对比见 `mimocode-vs-neo.md`
> 方法：3 个并行探索 agent 深挖 /tmp/mimo-code（packages/opencode/src 为主）

## TL;DR — 最值得 Neo 借鉴的 10 项（按 ROI 排序）

| # | 设计 | 领域 | 一句话 |
|---|------|------|--------|
| 1 | taskGate/goalGate 条件停止门 | runtime | "必须满足业务条件才能 stop"，比 step counter 通用 |
| 2 | 三层 doom loop 防护 + stableStringify 签名 | runtime | doom-loop(人工)→repeated-step(nudge)→invalid-output(自动续) |
| 3 | 未闭合代码块的流式分块渲染 | UX | 长代码流式输出不再"看起来卡住" |
| 4 | 权限审批 diff 视图 | UX | 可视化权限影响，split/unified 自适应终端宽度 |
| 5 | prefix cache 字节对等 + ForkContext 冻结 | runtime | fork agent 缓存命中从概率变确定 |
| 6 | REST + SSE + 类型化事件总线（不用 WebSocket） | 架构 | 薄客户端 + 中心化业务逻辑，三端共享一套 API |
| 7 | Timeline + Revert + Fork 分支体验 | UX | 消息级回退/分叉，自动填充提示框 |
| 8 | delta 级落盘 + snapshot patch tracking | runtime | 实时渲染 + 文件修改可视化 + 中断可恢复 |
| 9 | sidebar slot + order 插件体系 | UX | 第三方无侵入扩展 sidebar，order 排序竞争 |
| 10 | run 命令的 CI 友好设计 | CLI | --format json + 默认 deny 交互权限 + stdin 管道 |

---

## 一、Agent Runtime（packages/opencode/src/session/prompt.ts 2120-2959 等）

### 1.1 主循环与停止判定

一轮 turn：上下文组装（按 agentID 隔离消息切片 + recall hints + context 压力警告 + 重复步骤检测）→ LLM 调用（普通 process 或 MaxMode）→ 工具执行 → `classifyAssistantStep()` 五类判定（continue/final/think-only/invalid/filtered/failed）→ **二级门**。

**taskGate + goalGate【借鉴优先级：高】**：模型想 stop 时，先过 task gate（存在非 terminal 任务 → 注入"please call task done"合成消息重入，上限 MAX_TASK_GATE_MAIN_REACT）再过 goal gate（judge 评估，不满足 → 注入理由重入，上限 12）。不是锁，是合成用户消息重入机制。Neo 的 goal 三层闸已覆盖 goal 侧，但 **task gate（任务树没收完不让停）** 是 Neo 没有的。

### 1.2 Doom Loop 三层防护【高】

- **L1 doom-loop**（processor.ts:395-422，阈值 3）：最近 3 个 tool call 同名同 input（`stableStringify` 排序 key 防 JSON key 重排假阳性）→ 触发 `permission.ask({permission: "doom_loop"})` 人工确认，后台 agent 直接拒绝
- **L2 repeated-step**（prompt.ts:2353-2391，阈值 3）：最近 3 个 finished step 的"行动签名"（工具名+input，排除纯文本）相同 → 注入 nudge，不拒绝，让模型自己换策略
- **L3 invalid-output 自动续接**：think-only / empty 输出计数续接；finish="length" 截断自动续接。计数器局部于 runLoop，每轮用户输入重置

### 1.3 流式与持久化【高】

- AI SDK streamText，chunk timeout 8 分钟（防 MiMo Router 冷启动），per-provider 可配
- **delta 级落盘**：text/reasoning delta 实时 `updatePartDelta`（SQLite `UPDATE … || content` 字符串拼接），中断时部分结果可见
- **snapshot patch tracking**：每 step 前后对比文件快照，PatchPart 记录修改，驱动 diff 可视化和 revert
- MessageV2 part 体系：Text/Reasoning/Tool(state 状态机 pending→running→completed/error)/File/Snapshot/Patch/Subtask/Compaction，discriminated union 类型安全

### 1.4 错误与重试【中高】

- 错误分类单一来源（retry.ts:31-46）：429/5xx/529/网络/SSE timeout 可重试；401/403/400/404/422/context overflow/用户中止不重试
- 延迟优先尊重 `retry-after` 响应头，降级指数退避 500ms×2，10 次上限
- abort 传播：ESC → Runner.cancel → Effect.interrupt → processor onInterrupt → settleToolCall 清空待执行工具

### 1.5 性能工程【高】

- **prefix cache 字节对等**：`buildLLMRequestPrefix` 被主循环和 checkpoint-writer 共用，同入参同输出，保证 cache 命中
- **ForkContext 冻结**：subagent spawn 时捕获 parent 的 system + inheritedMessages 快照，后续步骤复用冻结快照而非重算 → fork agent 缓存命中确定性
- checkpoint-writer 后台化：不堵主循环
- `predict_next_prompt` 实验功能：用小模型预测用户下一条输入（<100 字符），预填输入框 hint

### 1.6 权限四层防线【中高】

agent 级 ruleset → session 级约束 → per-message 工具条带（user.tools）→ actor 白名单（subagent 工具数组），从宽到窄。memory 工具的 edit 独立于 permission 系统，防 deny 规则破坏 checkpoint 写入。

---

## 二、前端 / UX 设计（cli/cmd/tui/ + packages/ui/ + desktop/）

### 2.1 信息架构【高】

- 三段式布局：主消息区自适应 + sidebar 固定 42 字符 + 底部输入框/状态栏
- **sidebar slot + order 插件体系**：Goal(350)/Task(400)/MCP(200) 等都是 feature-plugin，通过 `api.slots.register({order, slots})` 注入，第三方无侵入扩展；状态只读暴露
- **Task 面板折叠策略**：in_progress→open→blocked 全显，最近完成只显 3 条（RECENT_DONE_LIMIT），其余折叠为"▸ N more done"；深度缩进表达任务树
- Footer 条件渲染：权限待审 >0 才显示 △，避免信息过载

### 2.2 流式渲染【高】

- **未闭合代码块分块**（packages/ui/src/components/markdown-stream.ts）：live 流式时检测 unclosed code block，拆成 [前文, 代码块] 两块分别渲染——用户不用等整个 codeblock 完成
- markdown→HTML 缓存 200 条（checksum 去重）；DOMPurify + 代码块自动 Copy 按钮
- thinking block：默认 hide，`**粗体标题**` 提取为摘要行，展开看正文；偏好 KV 持久化

### 2.3 关键交互【高】

- **权限审批 diff 视图**（routes/session/permission.tsx）：直接展示 filepath + diff，终端宽 >120 用 split 否则 unified，`diff_style` 可配——比纯文本描述更能建立"允许"的信心
- **Timeline + Revert + Fork**：timeline 列出所有用户消息（倒序、单行化），每条可 Revert（撤销消息+文件改动，原文自动回填输入框）/ Copy / Fork（分支新 session）
- **Leader key 模式**：vim 风格 `<leader>x` 快捷键，2s 超时自动退出；36 种文本编辑操作全可配
- Question 多问题 Tab 分离 + 数字快捷键（≤9 个选项）+ 最后 Confirm 页回顾
- Dialog 栈（嵌套对话框）+ 选中文本自动复制到剪贴板

### 2.4 工程细节【中】

- 错误页"Copy issue URL"一键预填 GitHub issue（含版本/错误信息）
- 启动加载延迟 500ms 显示（防闪烁）
- plain terminal 检测：低端终端降级 10fps/禁鼠标/main-screen 模式
- 25+ 预制主题（JSON 定义 45+ 颜色变量，dark/light 变体），17 语言自动检测
- tui.json（持久配置，全局/项目级联）与 KV store（运行时状态）分离

### 2.5 Desktop（Electron）【中】

window state 持久化、markdown 解析放主进程（防渲染进程卡顿）、nativeTheme 自动 dark mode、`virtual:opencode-server` Vite 虚拟模块把 server 预打包进 Electron。

---

## 三、CLI 设计与多端架构

### 3.1 核心架构决策：业务逻辑 100% 在服务端【高——与 Neo 差异最大的一点】

```
CLI(run/TUI) ─┐
Electron ─────┼── SDK(openapi-ts 自动生成) ── Hono Server(REST + SSE) ── Session/Tool/Permission/Memory
Web console ──┘
VSCode 扩展 ──┘ (纯 HTTP，无 IPC)
```

- 三端全是薄客户端，只做格式化展示；server 可内存模式（`http://opencode.internal` 内存 fetch）或网络模式
- **对照 Neo**：Neo 是 Tauri 桌面（src-tauri/ 壳 + TS 主进程承载业务逻辑），CLI/Web 是分叉路径。MiMoCode 的 server-centric 模式让多端一致性免费获得——这是架构层面最值得评估的差异

### 3.2 事件系统【高】

- `BusEvent.define(type, zodSchema)` 类型化事件 + Effect PubSub；SSE `/event` 端点每连接独立 AsyncQueue，10s heartbeat 防代理断连
- **刻意不用 WebSocket**：SSE + heartbeat 足够稳定，省去连接管理/重连复杂度
- GlobalBus 跨 instance 桥接（多工作区事件汇聚到全局监听）
- plugin hook（同步拦截，可拒绝）与 bus event（异步通知）分工清晰

### 3.3 run 命令设计【高，Neo CLI 可直接对标】

- `--format json|default`（流式事件 vs 格式化文本）、`--attach` 连远程 server、`--continue/--session/--fork` 会话续接
- 非 TTY 自动读 stdin；12 种工具有专属 inline/block 渲染
- **CI 安全默认**：run 模式 question/plan_enter/plan_exit 全部默认 deny，防 CI 挂起；`--dangerously-skip-permissions` 显式逃生门

### 3.4 多端 UI 复用策略【中高】

- 统一 Solid.js：终端用 `@opentui/solid`（Solid→ANSI 渲染），Web 用标准 SolidStart，Electron 包装 Web SPA
- **不共享 UI 组件，共享设计语言和业务逻辑**——结论：跨终端共享组件成本太高，共享 SDK + 设计系统即可

### 3.5 InstanceState + ScopedCache【高】

多客户端连同一项目目录时，按目录缓存重资源（SQLite 连接/Git 状态），目录卸载自动清理。Effect Layer 依赖注入 30+ 服务。多工作区/多窗口产品的资源管理范本。

### 3.6 配置与分发【中】

- 配置级联：内置默认 → `~/.config/mimocode/` → `~/.mimocode/` → 项目 `.mimocode/`（向上查找 stop at worktree）→ 环境变量 → CLI 参数；数组字段 concat 不覆盖
- OpenAPI schema 作为 SDK 生成唯一真实来源（hey-api/openapi-ts）
- 7 种安装渠道（npm/brew/choco/scoop/curl…），升级命令自动检测安装方式调对应包管理器；PTY 按运行时条件导出（node-pty vs bun-pty）

---

## 四、对 Neo 的行动建议

**直接可抄（小改动高收益）**：
1. doom loop 三层防护（Neo 有声明式 DAG 的反死循环，但主循环级的 stableStringify 签名检测没有）
2. 未闭合代码块流式分块（渲染层独立改动）
3. 权限审批 diff 视图（Neo 有 GuardFabric 决策链，但呈现层可升级）
4. run/CLI 的 CI 安全默认（非交互模式 deny question 类权限）
5. task gate（任务树未收完不让 stop——Neo 的 TaskManager 已有数据，缺 gate）

**值得立项评估（中等工程量）**：
6. Timeline + Revert + Fork 的消息级分支体验（Neo 有 rewind/fork 后端，交互层可对标）
7. prefix cache 字节对等改造（Neo 的 subagent spawn 重算上下文，缓存命中率有提升空间）
8. sidebar slot 插件化（Neo renderer 组件耦合较深）

**架构层思考题（大决策，不急）**：
9. server-centric vs Tauri-主进程-centric：Neo 三端一致性的长期成本 vs 迁移成本
10. SSE + 类型化事件总线 vs 现有 IPC + SSE 混合

**Neo 已领先、无需借鉴**：6 层上下文压缩、goal 三层闸 + 持久化、命令式 workflow 引擎、eval 体系、Computer Use/视觉能力、hook 引擎。
