# Configuration Scope and Admin Boundary

这份文档定义多用户个性化和管理员权限隔离的验收口径。它只管产品和技术边界，不代表当前所有实现已经完成。

## Product Boundary

普通用户默认只看到自己的运行对象，并且优先看到产品化状态、健康信息和引导动作。

| Area | 普通用户可见 | 普通用户默认不可见 |
|---|---|---|
| Models | 自己的 provider/key 状态、模型选择、用途路由、连接测试、预算摘要 | 全局 provider key、云端模型池、全局路由、跨用户成本明细、eval 专用模型池 |
| MCP | 自己或当前项目的 server、enabled/status、transport、tools/resources 数量、last error、连接测试、disabled draft 管理 | 跨用户 MCP、全局分发策略、secret 原文、raw import/export、未脱敏 env/header/OAuth |
| Skills | 自己安装或当前项目启用的 skills、来源、scope、trust/依赖提示、更新和移除 | 全局 skill 推送、远程市场治理、内部录制数据、跨用户启用状态 |
| Channels | 自己的飞书/Telegram/HTTP API 等账号、连接状态、隐私模式、默认路由、inbox/outbox 健康摘要 | 跨用户消息、脱敏前 raw payload、全局 webhook 策略、平台级 channel 配额 |
| Memory | 自己的 Light Memory、screen/activity memory、最近记忆摘要、删除/禁用、隐私黑名单 | 其他用户记忆、raw audit dump、ActivityContext raw preview、内部 context intervention |
| Automation | 自己创建的自动化任务、启停、下次运行、最近运行、失败原因、手动运行 | 全局 scheduler、worker 队列、跨用户任务、平台级执行限额 |
| Workspace | 当前/最近/默认工作区、本地桥状态、项目配置命中、索引状态 | 其他用户工作区、平台文件扫描、内部 bridge debug payload |

管理员可见的能力必须满足一个判断：它会影响别人、平台成本、全局执行、安全策略、能力分发，或内部质量数据。典型管理员区包括用户/角色/邀请、组织和账单、全局 provider key、模型池和路由默认值、全局 scheduler/worker/swarm、managed permission policy、bypass/dev mode、远程 marketplace 治理、全局模板分发、Eval Center internals、review queues、raw telemetry、debug snapshots、doctor logs、安全审计记录。

配置作用域和管理员权限是两件事。个人本地配置可以给普通用户看，平台治理能力必须进管理员区；UI 上藏起来不算权限隔离，IPC 和后端读取也要拦。

## Config Scope

| Scope | 写入建议 | 典型路径 | 迁移和共享规则 |
|---|---|---|---|
| User | 跨项目个人偏好：模型选择、个人 MCP、个人 skills、个人 channels、个人 memory、个人 automation、`SOUL.md` | `~/.code-agent/*` | 默认私有。不要复制进项目模板，不要提交到项目仓库。 |
| Project | 团队共享事实：`PROFILE.md`、项目 MCP/skills/rules、项目工作区约定、项目默认能力 | `<project>/.code-agent/*` | 提交前必须 review。只放项目事实和可共享配置，不放个人偏好、token、私有路径。 |
| Local | 当前机器或当前 clone 的覆盖：端口、私有 endpoint、本地 token、临时调试开关 | `<project>/.code-agent/*.local.*` | 必须进 `.gitignore`。它可以覆盖 Project，但不能成为团队默认值。 |
| Runtime | App 状态：secure storage、database、logs、cache、browser profile、screen memory、session runtime | app user data dir / secure storage | 本机私有状态。迁移时只导出脱敏摘要，默认不进 config bundle。 |

新增配置先定 scope 再定 UI。产品默认值放内置模板或代码；个人行为写 User；团队约定写 Project；secret 和机器差异写 Local 或 Runtime；管理员策略不落到普通用户可编辑的本地配置里，未来有云端管理时走 managed policy。

Workspace Settings 现在把这条规则做成只读写入指导，不提供 raw 编辑器：

| Config type | 推荐写入层 | 团队共享 |
|---|---|---|
| 身份、记忆、个人偏好 | User | 不共享 |
| 项目画像、规则、团队约定 | Project | review 后共享 |
| MCP 共享模板 | Project | 无 token、私有 endpoint 时可共享 |
| MCP token、端口、私有 endpoint | Local 或 User | 不共享 |
| hooks 与自动化命令 | Project 放团队验证；User 放个人自动化 | 只共享可审计、可复现的项目 hooks |
| skills、agents、工作流模板 | Project 放团队模板；User 放私人方法 | review 后共享 |
| UI 偏好、最近目录、浏览器 profile、本地 DB | Runtime | 不共享 |

共享前检查只返回风险摘要和命中位置，不把匹配到的 raw 配置值传给 renderer。当前最小扫描范围包括 `<project>/.code-agent/mcp.json`、`<project>/.code-agent/hooks/hooks.json`、`<project>/.code-agent/settings.json`、`<project>/.code-agent/skills`，以及常见错位 hooks 文件。风险类别包括绝对路径、疑似 secret、localhost/内网 endpoint、危险 shell 模式和 hooks 写错位置。

## Migration Notes

- `SOUL.md` 是 User scope，`PROFILE.md` 是 Project scope。把 `SOUL.md` 复制到项目模板会把个人身份和偏好泄到团队配置里。
- Legacy `.claude` 只当导入来源或兼容来源，迁移时要保留 provenance。不要把 `.claude/settings.json` 自动当成 Code Agent 的项目默认配置，也不要把其中的 token、MCP secret、个人 hooks 直接提交。
- Hooks 当前有效来源是 `~/.code-agent/hooks/hooks.json`、`<project>/.code-agent/hooks/hooks.json`，以及兼容读取的 legacy `.claude/settings.json`。`<project>/.code-agent/settings.json` 里的 `hooks` key 不是有效 hook 配置，不能把它当作 hooks 已生效的验收证据。
- MCP/Skills/Channels 从旧配置迁移时，先生成 disabled draft 或 needs setup 状态，再由用户确认启用。迁移完成不等于启用成功。
- Project config 分享前要扫描 `.code-agent/` 下的 secret、私有路径、raw payload、用户 id/email、local override、legacy `.claude` 引用和管理员开关。

## Acceptance Checklist

| Check | 验收标准 |
|---|---|
| UI visibility | 普通用户主设置只出现自己的 Models、MCP、Skills、Channels、Memory、Automation、Workspace，并显示产品化状态。管理员入口只对管理员出现。 |
| Search visibility | Settings search、command palette、deep link 和全局搜索遵守同一 visibility 规则。普通用户不能搜到管理员菜单名、跨用户对象、raw config 标题或内部 eval/debug 项。 |
| IPC guard | 管理员区、跨用户数据、全局成本、全局执行、安全策略、raw telemetry/eval/debug 的 IPC 必须做 role/user/project guard。拒绝时只返回权限错误，不带被拒数据片段。 |
| Raw not shown | secret、raw MCP JSON、env/header/OAuth、channel raw payload、hook source/matcher、memory audit dump、telemetry events、structured replay、debug snapshot 默认不展示；需要展示时必须在高级/管理员/调试区，并做脱敏和确认。 |
| Project sharing scan | 提交或导出 Project scope 前，扫描 `.code-agent/`、legacy `.claude` 引用、`*.local.*`、token、私有路径、用户数据和管理员策略。`.code-agent/settings.json` 的 `hooks` 字段不能作为 hooks 生效证明。 |

验收结论只在五项都通过时才算完成。只做 UI 隐藏、只做文档、或只做本地路径分层，都不能算管理员权限隔离闭环。
