# 数据流与能力边界说明

本文把 `docs/ARCHITECTURE.md` 第 10 节的集成边界和隐私设置页的边界索引，按代码入口重新整理成两张表。表内描述只表达代码能够支持的“可能 / 可以 / 不能仅凭……推定”关系；行末锚点指向 `origin/main` 中用于核对的代码位置。出网执行点一列暂留 `待 ADR-066`：本仓没有一个可以据此宣称所有出网都经过同一全局白名单的统一执行点，不能把单个 URL 校验器或系统代理写成全域防火墙。

## A. 能力钩子 × 影响边界

| 能力 | 何时运行 | 可以读取或改变什么 | 在哪里配置 | 代码锚点 |
|---|---|---|---|---|
| Hooks | 用户提示、会话、工具前后或停止事件命中匹配器时可能运行脚本或提示钩子 | 具体上下文和脚本结果由事件配置决定；不能仅凭钩子名称推定其可写范围 | 项目/用户 hooks 配置文件及运行时合并配置 | `src/host/hooks/configParser.ts#L527-L543` |
| Plugins | 插件被发现、加载、激活或热重载时可能注册工具和界面能力 | manifest、插件工具和插件声明的能力可能改变运行时工具面；不能仅凭注册成功推定外部服务权限 | 插件目录、manifest 与插件设置 | `src/host/plugins/pluginRegistry.ts#L694-L706` |
| Skills | 任务匹配到 skill 或显式调用 skill 时可能注入说明并收窄工具集 | skill 正文、allowed-tools 和上下文可能影响本轮提示与可见工具；不能仅凭正文推定获得更宽写权限 | 项目/用户 `SKILL.md` 与会话挂载配置 | `src/host/services/skills/skillParser.ts#L176-L190` |
| MCP tools | MCP server 连接并完成工具发现后，模型或用户调用工具时可能运行远程或本机工具 | 工具参数、资源和工具结果可能离开本机或改变工作区；不能仅凭工具索引推定其副作用 | MCP server 配置、OAuth 或 env/header 凭据 | `src/host/mcp/mcpClient.ts#L447-L465` |
| Connectors | 连接器按设置启用并被具体动作调用时可能访问本机应用或外部业务服务 | Calendar、Mail、Reminders、Photos 或外部 connector 的读写范围由 connector 声明决定 | connector registry 的 enabled IDs 与各 connector 设置 | `src/host/connectors/registry.ts#L69-L88` |
| Channels | 渠道账号连接后，入站消息触发任务或出站动作发送回复时可能运行 | 消息、sender/chat 元数据和附件可能进入会话，回复可能发往对应渠道；不能仅凭渠道类型推定数据范围 | 渠道账号配置、隐私策略和出站目标设置 | `src/host/channels/channelManager.ts#L513-L528` |
| Cron / scheduled tasks | 本地或云端调度到期且任务启用时可能启动 agent、shell、tool 或 webhook 动作 | action 的 prompt、命令、参数或 URL 可能被调度执行；不能仅凭 schedule 字段推定任务结果 | cron job definition、runsOn 和 schedule 配置 | `src/host/cron/cronService.ts#L443-L460` |

## B. 出站请求

| 请求 | 触发条件 | 数据范围 | 接收方 | 代码锚点 | 出网执行点 |
|---|---|---|---|---|---|
| 模型请求 | 选定 provider 且本轮需要推理时可能发起 | prompt、工具结果和必要附件可能随 provider 请求发送；不能仅凭路由函数推定具体字段 | 用户配置或 provider 解析出的 model endpoint | `src/host/model/providers/providerResolution.ts#L78-L124` | 待 ADR-066 |
| Supabase telemetry uploader | 遥测开关可用、已登录且存在待同步记录时可能上传 | session/turn 元数据、反馈、renderer bundle attempt、诊断包和评分行的范围由上传映射决定 | Supabase telemetry 表 | `src/host/telemetry/telemetryUploaderService.ts#L240-L303` | 待 ADR-066 |
| Langfuse tracing | Langfuse key 存在且 tracing enabled 时可能创建 trace、span 或 generation | trace metadata、输入输出和事件字段可能发送；不能仅凭配置对象推定内容筛选结果 | 配置的 Langfuse base URL | `src/host/services/infra/langfuseService.ts#L84-L101` | 待 ADR-066 |
| 诊断包导出（第三条遥测边界） | 用户主动导出会话诊断日志时可能生成导出内容 | 诊断包和本地日志尾部的字段由导出函数组装；输出先交给用户，后续分享对象不能仅凭代码推定 | 用户指定的本地输出或其后续分享对象 | `src/host/telemetry/diagnosticBundleService.ts#L355-L406` | 待 ADR-066 |
| Supabase evolution 同步 | evolution 初始化、创建或更新策略/模式时可能读写云端表 | learned strategies、patterns 及其时间和项目字段可能同步 | Supabase `evolution_strategies` / `evolution_patterns` 表 | `src/host/services/infra/evolutionPersistence.ts#L401-L416`、`#L487-L505` | 待 ADR-066 |
| 云 cron | 配置了 cloud cron 且需要对账、注册或接收运行事件时可能请求云端 API | schedule、agent prompt、shell/webhook/tool action 参数可能进入云端任务声明；不能仅凭本地 job id 推定服务端处理 | 配置的 cloud cron API（含事件流） | `src/host/cron/cronApiClient.ts#L68-L107`、`#L297-L315` | 待 ADR-066 |
| Firecrawl 搜索/抓取 | 研究路径选择 Firecrawl 且目标 URL/搜索条件满足调用条件时可能 POST | 搜索 query、目标 URL、域名过滤和返回内容可能发送 | `SEARCH_API_ENDPOINTS` 指向的 Firecrawl 服务 | `src/host/tools/web/firecrawlClient.ts#L216-L274` | 待 ADR-066 |
| 飞书 channel | 已连接的 Feishu 账号发送文本或卡片时可能调用平台 API | chat id、回复关系和消息正文可能发送；不能仅凭 channel manager 推定附件字段 | 飞书消息 API 的接收方 | `src/host/channels/feishu/feishuChannel.ts#L375-L411` | 待 ADR-066 |
| Companion relay | 手机端没有可用 LAN 路径或选择 relay 路由时可能建立 WSS 并恢复会话 | 配对身份、route ticket、scope 和会话帧可能经过 relay；不能仅凭 relay URL 推定帧内容 | 配对时保存的 relay 服务 | `packages/mobile/src/stores/companionStore.ts#L653-L694` | 待 ADR-066 |
| MCP OAuth | 用户开始 connector OAuth、回调换码或 access token 过期需要刷新时可能请求授权/令牌端点 | issuer、redirect、授权码、PKCE verifier、scope 和 token 响应可能参与交换；不能仅凭本地 token store 推定第三方字段 | descriptor 指定的 authorization/token endpoint | `src/host/connectors/oauth/connectorAuth.ts#L52-L110` | 待 ADR-066 |
| 更新检查与下载 | 启动或手动检查更新且配置允许时可能请求 manifest 并下载资产 | 当前版本、平台、架构、channel 和下载资产字节可能发送/接收；不能仅凭摘要推定安装结果 | 更新 API、发布 manifest 或资产 URL | `src/host/services/cloud/updateService.ts#L524-L558`、`#L1042-L1081` | 待 ADR-066 |

## 口径

这些表是代码入口索引，不是对每次运行的事实断言。是否真的触发、发送了哪些字段以及用户是否撤回，仍可能取决于设置、凭据、权限、网络和本轮数据；不能仅凭本文件推定“所有出网都经过同一个全局执行点”。
