# ADR-050：MCP 配置里的凭据引用（`secureref:`）

- 状态：已采纳
- 日期：2026-07-24
- 相关：ADR-042（MCP OAuth 授权）、ADR-049（能力中心 —— 一个能力只有一个家）

## 背景

连接器面板里"发现连接"一键装 MCP server 时，`handleAddServer` 会调 `persistMcpSettingsServerConfig`，把**整个 server config 原样写进 `<workingDirectory>/.code-agent/mcp.json`**，其中包含 `env` 里的凭据明文。

这条路径有三个问题：

1. **落点是项目目录**。对 cowork 用户，工作目录经常就是一个 git 仓库 —— 一键连接的副作用是把 API key / App Secret 写进待提交的文件。
2. **和 Neo 既有的凭据纪律不一致**。模型 provider key 和服务 key 走 SecureStorage（`configService.getApiKey` / `getServiceApiKey`），多字段凭据走 `integration.<id>` 槽（Jira 在用）。只有 MCP server 的凭据是明文落盘的。
3. **不是单个连接器的问题**。`mcpCatalog.ts` 里带 `requiredCredentials` 的条目（exa / firecrawl / github / 飞书 …）全部同病，谁先被装谁先泄露。

直接触发点是飞书数据源接入：它要存的是长期有效的 App Secret（应用身份 tenant token 的换取凭据），明文落进项目目录不可接受。

## 决策

**mcp.json 的 `env` / `headers` 值允许写成引用串 `secureref:<integrationId>.<field>`，真值存在 SecureStorage 的 `integration.<integrationId>` 槽里，连接前在宿主侧解引用。**

- **写**：连接器面板保存凭据时，敏感字段真值经 `configService.setIntegration()` 落 SecureStorage；写进 mcp.json 的是引用串。非敏感字段（如 App ID、域名）照旧明文，便于用户自己看懂配置。
- **命名空间**：MCP server 的凭据存 `integration.mcp_<serverName>`（下划线前缀，与 Jira 等既有 integration 槽隔离）；引用串形如 `secureref:mcp_feishu.APP_SECRET`。`integrationId` / `field` 均不得含 `.` 或 `:`（引用串的两级分隔符），违反即抛错。
- **读**：解引用发生在 **`mcpClient` 组装 server config 的那一处**，`mcpTransport` 保持纯函数、不依赖宿主服务。
- **解不开时 fail-closed**：不连接、不启动子进程，向用户报可操作的错（"凭据丢失，请到连接器重新填写"）。**禁止回落空串**——那会产生一个连不上又不报错的幽灵 server，是比明文更难查的故障。
- **不迁移存量**：已经明文落盘的条目继续按原样工作。此机制只约束新写入。

## 权衡

**为什么不给飞书单开一条内置通道（凭据只走 `integration.feishu`，server 配置写死在代码里）**
那样只修一个连接器，其余带 key 的条目继续明文落盘；且同一个能力会同时有"内置条目"和"目录条目"两个家，与 ADR-049 冲突。明文落盘是**共享写路径**的缺陷，修在共享处的长期 diff 更小。

**为什么不直接加密整个 mcp.json**
mcp.json 是用户可读可手改的配置文件（user / project / local 三档 scope 是既有设计）。整体加密会毁掉这个属性，且和 `.mcp.json` 生态惯例不兼容。引用串保留了"文件仍然可读、只有敏感值不在里面"。

**为什么不用 `${ENV_VAR}` 占位**
云端配置转换路径（`convertCloudConfigToInternal`）已有 `${VAR}` 语义，指向的是**进程环境变量**。复用同一语法表达"去 SecureStorage 取"会让两种来源在同一个位置混淆。`secureref:` 前缀显式区分来源。

**已知边界**
- 引用只覆盖 stdio `env` 与远程 `headers` 两处，不覆盖 `args`（凭据本来就不该进 args —— 会出现在 `ps` 输出里，这条是硬规则，不是可选项）。
- 用户手改 mcp.json 时可以自己写引用串，但 SecureStorage 里没有对应记录就会 fail-closed。这是刻意的：宁可连不上并报错，不要静默降级。

## 影响面

| 文件 | 变化 |
|---|---|
| `src/host/mcp/mcpClient.ts` | 连接前解引用 `secureref:`，解不开 fail-closed |
| `src/host/ipc/mcp.ipc.ts` | 保存时把敏感字段替换成引用串 |
| `src/host/services/core/configService.ts` | 复用既有 `getIntegration` / `setIntegration`，无新增 API |
| `src/renderer/.../MCPSettings.tsx` | 预填编辑器把引用串显示成"已保存"，不把内部串怼给用户 |

`mcpTransport.ts` 不变（保持纯函数）。
