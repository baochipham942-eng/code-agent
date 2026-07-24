# ADR-051：能力中心连接器持久化到用户级，不绑工作目录

- 状态：已采纳
- 日期：2026-07-24
- 相关：ADR-049（能力中心 —— 一个能力只有一个家）、ADR-050（MCP 凭据 secureref 引用）

## 背景

从能力中心「连接器」添加一个 MCP server（快速连接 / 凭据编辑器保存）时，`handleAddServer` 调 `persistMcpSettingsServerConfig(workingDirectory, …)`，把 config 写进 `<workingDirectory>/.code-agent/mcp.json`——即**项目级**路径。

`workingDirectory` 来自 `options.getWorkingDirectory()`。当用户**没有打开任何项目文件夹**（cowork 用户打开 app 只为连一个飞书/Notion，这是常态）时，工作目录默认成 **app 自身的 bundle 目录**（`/Applications/Agent Neo.app/Contents/Resources`）。那是**只读、已签名**的目录，`fs.writeFile` 被系统拒绝。

后果（2026-07-24 真机 dogfood 实测）：**保存静默失败，连接器存不住**。用户填完飞书 App ID/Secret 点保存，什么都没落盘（`~/.code-agent-dev` 零文件写入、`secure-storage.json` 未被触碰），再打开又是空的。飞书、exa、firecrawl、github 等所有需要凭据的连接器，只要在"没开项目"时保存，全部撞同一堵墙。

## 决策

**能力中心添加的 MCP 连接器持久化到用户级 `~/.code-agent/mcp.json`，不再绑工作目录。**

依据：按 ADR-049，能力中心是"一个能力只有一个家"的**全局**入口；从它添加的连接器是跨项目的用户资产，语义上就该用户级，不该随某个项目目录走。加载侧 `loadMcpConfigFiles` 本就已读用户级 scope（优先级 user < project < local），所以用户级写入天然被下次启动加载，闭环无需改加载侧。

落地：`addServer` IPC 接受可选 `scope: 'user' | 'project'`；能力中心（MCPSettings）显式传 `'user'`；handleAddServer 据此写用户级路径。缺省保持 project 行为，不影响任何假想的项目级调用方。

## 权衡

**为什么不是"工作目录不可写时回退用户级"**
那是把"全局连接器错绑了项目目录"这个语义错误用一个 IO 兜底掩盖掉。连接器本就是用户级，显式声明 scope 比"写失败再换地方"更清晰、更可测。

**为什么不干脆废掉项目级 MCP 配置**
项目级 `.mcp.json`（随仓库走、团队共享）是既有且有价值的设计（ADR 无关方）。本决策只改**能力中心这个添加入口**的默认落点，不动项目级 `.mcp.json` 的加载与手写。

**已知边界**
- 已经（因本 bug）没存住的连接器不涉及迁移——它们从来没落盘。
- 用户级文件被多台机器/多 worktree 共享时的并发写不在本 ADR 范围（现有 read-modify-write 已是单文件全量覆盖，风险与既有 user-scope 写入一致）。

## 附带修正（同批一起修，都是这次 dogfood 暴露的）

1. **凭据抽取与落盘的调序**：ADR-050 的实现里 `setIntegration`（写 SecureStorage）在 `persistMcpSettingsServerConfig` **之前**。若 persist 失败，密钥已孤儿式留在 SecureStorage。改为 **persist 成功后再 setIntegration**，失败则不留孤儿。
2. **敏感键分类误判**：`LARK_TOKEN_MODE`（值是配置枚举 `tenant_access_token`，非密钥）命中了 `SENSITIVE_MCP_KEY_PATTERN` 的 `token` → 被当密钥掩码并抽进 SecureStorage。收窄判定，令配置型键（`*_MODE` 一类）不被误当凭据抽取。
