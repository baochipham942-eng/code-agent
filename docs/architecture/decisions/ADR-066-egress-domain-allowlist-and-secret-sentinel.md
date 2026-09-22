# ADR-066：出网目的地白名单与凭据哨兵（egress allowlist + secret sentinel）

- 状态：**待爸拍板**
- 日期：2026-09-13
- 工单：N-EGRESS-SECRETMASK-ADR（SOTA D08-03 / D08-04 / 并入的 D08-13）
- 相关：ADR-050（MCP `secureref:`）、ADR-036（红线 OS jail）、N-SANDBOX-DEFAULTON（A7，沙盒默认翻开）、N-BASHAST（命令解析深度）
- as-built 基线：origin/main@d3a62bad0（本单开工树 `feat/egress-secretmask-adr`）

本 ADR 只定形状，不改代码、不配基线。爸拍板后才拆施工单。

## 背景

SOTA 体检把出网与凭据写成权限维的机制缺口：OS 沙盒默认关，沙盒一旦放网是全开全关，bash 里的 curl 不走域名白名单，子进程凭据是删掉而不是打成替身。09-13 对代码复核后，缺口仍在，锚点与任务书有三处路径/计数偏差（见文末 as-built），以本文件为准。

今天的三道网和两道凭据是错开的：

| 层 | 做什么 | 不做什么 |
|---|---|---|
| OS 沙盒网络 | `resolveSandboxNetworkPolicy` 命中 25 个命令名之一就 `allowNetwork=true`（`src/host/sandbox/networkPolicy.ts`）。seatbelt 放行时省略 `(deny network*)`，bwrap 则 `--share-net`。只在沙盒真包装时生效。 | 没有域名；默认关（`OS_SANDBOX.ENABLED`，`src/shared/constants/sandbox.ts:15`）。日常 default 档 bash 裸跑。 |
| policy 域名白名单 | `policyEnforcer.checkNetwork`（`:75-118`）对 `network.allowed_domains` 做 hostname / `*.` 后缀匹配。 | 只在 `permissionLevel === 'network'` 且 `params.url` 是字符串时调用（`toolExecutor.ts:2549-2551`）。bash 的 curl/wget 没有 `params.url`，整层跳过。 |
| SSRF 守卫 | `isPrivateOrLocalHost` 已挡 169.254.169.254、RFC1918、环回、链路本地、IPv6 ULA（`ssrfGuard.ts:17-45`）。 | 只守 7 个 fetch 侧消费方（`workspace.ipc` / `workspaceDesignMedia.ipc` / `customRealtimeVoiceProviders` / `imageGenerationService` / `customVideoModelRegistry` / `customImageModelRegistry` / `bridgedEndpoint`）。bash 命令文本不调用它。`commandSafety` 的 `DANGEROUS_PATTERNS` 只有 `curl\|sh` / `wget\|sh`，没有私网/元数据。 |
| 子进程凭据 | `createEvalSafeShellEnv`（`bash.ts:60-90`）在 `filterSecretEnvVars` 里按名 **strip** `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_PASSWD`/`*_PWD`/`*_CREDENTIALS`。默认 fail-closed。 | 没有回填通道。bash 侧拿不到被删的变量。逃逸口只有 `[env_filter]`。 |
| MCP 凭据引用 | `encodeSecretRef` / `resolveSecretRefs`（`src/host/mcp/secretRef.ts`），前缀 `secureref:`。解不开 fail-closed，禁止回落空串（ADR-050）。 | 只在 MCP 连接前由宿主 `mcpSecretResolver` 解引用。bash/env 零消费方。 |

任务书写「`src/host/security/networkPolicy.ts` 约 40-42 行、命中 27 个网络命令」。代码里文件在 `src/host/sandbox/networkPolicy.ts`，`NETWORK_COMMANDS` 是 25 项（无 `nc`/`netcat`）。下文按代码。

## 北极星

bash 出网的目的地必须可审批、可持久化、可被 OS 层兜住；子进程默认看不到明文密钥，网络命令按需回填，失败不许变成空串。命令文本解析是预检，不是唯一闸。

## 决策

### D1 沙盒 profile 的网络段：布尔 + 环回例外；域名不进 profile

seatbelt 的网络过滤器按 sockaddr（IP/端口），不认 DNS 名。bwrap 只有 `--unshare-net` / `--share-net`。**域名白名单无法在 profile 层表达。**

目的地策略打开之后，profile 不再「放行就整网」：

- **macOS seatbelt**：保持 `(deny network*)`，只加 `(allow network-outbound (remote ip "127.0.0.1:<proxyPort>"))`。子进程只能 TCP 到本机代理。`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 指到该端口。子进程自己解析 DNS 会失败——这是刻意的：CONNECT 的 hostname 由代理解析。
- **Linux bwrap**：目的地策略打开时 **禁止** `--share-net`。继续 `--unshare-net`（与宿主编译栈隔离），把宿主 unix socket bind 进沙盒。unix 路径套接字不走 netns。沙盒内起一个随命令走的环回适配器：听 `127.0.0.1:<port>`，转到该 unix socket。工具继续走标准 `http://127.0.0.1:port` 代理变量（npm/git/pip/curl 都认这个，不认 unix URL）。
- **Windows**：`SandboxManager` 平台是 `unsupported`，profile 硬保证做不到。刀 0 / 刀 2 照做；刀 3 在 Windows 上只是 `HTTP_PROXY` 尽力而为，必须在审批卡和文档里写明「无 OS 围栏」，不许假装与 macOS/Linux 同级。

否决：只设 `HTTP_PROXY`、profile 仍 `--share-net` / 省略 `(deny network*)`。`python -c fetch`、`curl --noproxy '*'`、裸 TCP 都能绕过。

`NETWORK_COMMANDS` 的布尔语义保留给「要不要把环回代理插进这跳」。`python`/`node` 不在名单里 → `allowNetwork=false` → 无网（沙盒开着时）。复合命令里只要有一个名单内工具，整跳会插代理；不走代理的那段（同命令里的 python）会被 profile 挡住——这正是环回例外比「整网放行」多出来的那一格。

### D2 环回代理：宿主进程单例；哨兵不在代理上替换（v1）

| 问题 | 决定 |
|---|---|
| 谁起 | 宿主新服务（建议模块 `src/host/sandbox/egressProxy.ts`）。第一次「沙盒包装 + 需要出网」时懒起。桌面 = Node webServer 进程；CLI = CLI 进程。不按命令起，不按会话起。 |
| 谁杀 | 跟宿主走：webServer shutdown / CLI 退出。`wrapCommandForSandbox` 已有的 `cleanup()` 只杀沙盒内适配器和临时 profile，不杀代理。 |
| 听在哪 | 宿主侧 unix socket（`0600`，放在 os.tmpdir()，按 pid 区分）。macOS 额外在 127.0.0.1 上绑一个仅本机、随机端口，供 seatbelt IP 例外。Linux 只对沙盒暴露 unix socket。 |
| 做什么 | HTTP CONNECT / 明文 HTTP 代理。对 CONNECT 目标 hostname 做白名单 + `isPrivateOrLocalHost` 硬拒绝。审计只记 hostname 与放行/拒绝，不记头、不记 query、不记凭据。 |
| 凭据哨兵在哪一端 | **v1 不在代理替换。** HTTPS CONNECT 隧道对外层代理是不透明的，要看 Authorization 就得做 TLS MITM（沙盒内 CA、打证书钉扎）。v1 不做。哨兵回填见 D4。 |

否决：每条 bash 起一个代理（端口抖动、审批态对不上）；把代理放进 renderer；v1 上 MITM。

### D3 新域名审批卡：复用现卡；粒度是 hostname；always 进 user policy 的 additive 表

交互复用现成 `PermissionDialog` / CLI 审批卡，`type: 'network'`，`details.url` 填即将 CONNECT 的 URL。`forceConfirm=false`，这样 session/always 记忆可以生效。高危私网/元数据走 D5 刀 0，且刀 3 代理侧 **不能** always-allow。

四个按钮沿用 `ApprovalLevel`：`once` / `session` / `always` / `deny`。

| 档 | 落点 | 寿命 |
|---|---|---|
| once | 不记 | 这一次工具调用 |
| session | 宿主侧按 `sessionId` 的内存集合（renderer `permissionStore.memory.session` 的 `network:${hostname}` 只是 UI 镜像，**不以它为闸**；CLI 的「always」今天其实是会话 allowList，不能当跨会话真源） | 会话结束清空 |
| always | 用户级 `~/.code-agent/policy.toml` 新键 `network.approved_domains`（**additive**，追加 hostname） | 跨会话。设置页可删 |
| deny | 命令不执行 | — |

**为什么不写进现成的 `network.allowed_domains`：** 空数组的语义是「不限制」（`policyEnforcer.ts:91`，`createDefaultPolicy` 也是空）。往空表里塞一个域名会把「不限制」变成「只许这一个」。企业表若非空，它是 **天花板**：用户 always 只能是与它的交集；不在企业表里的域名卡上不出现 always，session/once 也被拒。

粒度：**hostname**，不是路径，不是 eTLD+1。`api.github.com` 与 `github.com` 分开问。这与现成 `permissionStore` 的 `network:${hostname}` 键一致，也与 CONNECT 看到的名字一致。

不预置 npm/github/pypi 种子名单（`AGENTS.md` §5.7：审批/沙箱默认不许放宽）。第一次 `npm install` 会为 `registry.npmjs.org` 出一张卡，用户点 session 或 always。这是接受的 DX 成本。

`bypassPermissions` / 无人值守 **不豁免** 目的地白名单。没有审批 UI 时，不在 session/always/企业表里的域名 fail-closed 拒绝（已有 `PermissionDeniedNoApprovalUi`）。YOLO 今天等于「名单命中就整网」，本 ADR 把它收紧；这是刻意的，不是回归。

`devModeAutoApprove`（ADR-058）同样不跳过目的地闸——它只跳过工具确认，不是出网围栏。

### D4 哨兵：strip → `secureref:env.NAME` 注入 → 网络命令这一跳按需回填；失败 fail-closed

复用 ADR-050 的 `encodeSecretRef` / `parseSecretRef` / `resolveSecretRefs`，**不**把进程环境写进 SecureStorage。

完整链路：

1. **Strip 仍在。** `filterSecretEnvVars` 继续按名识别。默认开，`[env_filter]` 逃逸口保留。
2. **注入引用，而不是删成「没有这个变量」。** 被剥的名字在子进程 env 里变成 `secureref:env.<VARNAME>`（`integrationId=env`，field=变量名；两者都不得含 `.`/`:`，与 ADR-050 同一约束）。真值留在宿主内存里的 spawn 快照（agent 的 `process.env` 本来就有），不落盘。`echo $GITHUB_TOKEN` 在非网络命令里打出引用串，进不了 transcript 明文；现成 `redactToolResultSecrets` 仍是事后网。
3. **按需回填。** 仅当 `resolveSandboxNetworkPolicy` 为 true（这一跳会被插代理 / 当前语义下会被放网）时，宿主在组装 sandbox 子进程 env 时把引用解回真值。`npm`/`gh` 读环境变量、命令文本里往往看不到 `$NPM_TOKEN`，所以回填的是这一跳里 **全部** 被剥过的名字，不是「命令文本里出现过的那些」。非网络命令不解。
4. **Fail-closed。** 命令文本里出现 `$FOO` 且 FOO 像密钥、引用却解不开 → 不 exec，错误用稳定 code（renderer i18n），**禁止**用空串顶上（ADR-050 同一条：空串是比明文更难查的幽灵失败）。lookup 服务的错误信息只带 `env.NAME`，不带真值。
5. **替换点 / 回填点。** 替换在宿主 `createEvalSafeShellEnv`。回填也在宿主、在 spawn 这一跳，不是代理 MITM，v1 也不在沙盒里再开 `neo-secret` 助手。真值会出现在该 bash 子进程的 env 里（`/proc/<pid>/environ`、崩溃转储），寿命等于这一跳。这是相对「永远 strip、网络命令直接失败」的有意让步，也是相对「TLS MITM 在代理替换头」的有意不做。

否决：网络命令也只给引用、指望 curl 把 `secureref:` 当 Bearer 发出去再由代理改（HTTPS 看不见）；LD_PRELOAD 拦 `getenv`（魔法、平台脆）；把进程 env 写进 `integration.mcp_*` 槽（和 MCP 凭据混名）。

`strip_secret_vars=false` 仍是总开关：关掉则不注入引用、不回填，行为回到今天。`allowed_secret_vars` 仍是按名放行明文。

### D5 bash 里 curl 的覆盖：预检解析 + profile 兜底 + 代理真源

分三层，谁也别假装能单独收口。

**刀 0 — 命令文本预检（近期第一刀，不依赖沙盒默认开）。**
`commandParse` 的 `executions` 今天能拆出 program/args/wrapper（含一层 `bash -c`、`sudo`/`command`/`env`），但 **零 URL 提取**。补：对 `curl`/`wget`/`nc`/`ncat`/`netcat`/`ssh`/`scp` 的字面 argv 抽 URL/host，喂给 `isPrivateOrLocalHost`。命中私网 / 环回 / 链路本地 / 元数据 → `commandSafety` 标 `high`，走确认（台账 D08-13 口径，不在刀 0 硬毙，避免误杀内网开发）。`169.254.169.254` 与云元数据主机名在刀 3 代理侧改为硬拒绝，且不进 `approved_domains`。

解析 **做得到**：字面 URL；一层 `bash -c 'curl http://…'`（现成 `QUALIFICATION_SHELLS`）；同行赋值 `URL=http://… curl $URL` 若 parser 仍看得到字面。

解析 **做不到**，归到下一层，不在正则上加枚举：

| 做不到 | 归哪一层 |
|---|---|
| `bash -c` 套娃超过 wrapper 深度 4；`eval`；ANSI-C 与拼接把 URL 藏进不确定词 | parser `uncertain` / `parsingFailed` → 刀 0 当 high 确认（偏严）；真目的地靠刀 3 CONNECT |
| `$HOST`、`$(cat url)`、管道 `echo url \| xargs curl`、`curl -K file` | 同上 |
| `python -c urllib` / `node -e fetch` | 不在 `NETWORK_COMMANDS`：沙盒开着时无网（D1）；沙盒关着时刀 0 看不见——这是 N-SANDBOX-DEFAULTON 要先翻的原因之一 |
| `ssh`/`scp`/`rsync` 走的不是 HTTP 代理 | 刀 3 profile 只许环回 → 这些命令连不上远端。v1 **不**为 ssh 做 SOCKS。需要 ssh 的工作流继续走确认 + 沙盒外例外（DEFAULTON 白名单），不在本 ADR 开洞 |

**刀 3 真源**是代理看到的 CONNECT hostname，不是 argv。文本解析只负责出卡文案和刀 0 的私网确认。

### D6 与 N-SANDBOX-DEFAULTON 的先后

SOTA 原文：B7「依赖 B 沙盒默认开（A7）」；台账：「云端执行形态定下来之前不做整套」。云端执行不在本 ADR 范围（Neo 是本机 cowork）。「整套」= 刀 3。刀 0 是台账点名的近期最省一格，允许在沙盒仍默认关时先做。

| 刀 | 内容 | 依赖 |
|---|---|---|
| 0 | `commandSafety` 接 `isPrivateOrLocalHost`；从 curl/wget/nc/ssh/scp argv 抽 host | 无。沙盒关着也挡裸跑 bash |
| 2 | strip 改为注入 `secureref:env.NAME` + 网络命令回填 | 无。不依赖沙盒 |
| 1 | N-SANDBOX-DEFAULTON（另一张单）：日常 default/acceptEdits 也包装 OS 沙盒 | 与 0/2 并行，本 ADR 不施工 |
| 3 | 环回例外 profile + 宿主代理 + 新域名卡 | **blocked_by 刀 1**。沙盒仍是 opt-in 时，代理只罩 YOLO/eval/写围栏，日常 bash 仍可绕过，会制造假安全感 |

顺序：先拍本 ADR → 刀 0 可立即拆单 → 刀 2 可与刀 0 并行 → 刀 3 等 DEFAULTON 灰度住（误杀面可接受、真机 `sandboxed: true`）再拆。DEFAULTON 若因误杀停下只交降级显式化，刀 3 继续挂起，刀 0/2 不受牵连。

## 否决的替代

- **profile 里写域名。** 做不到，见 D1。
- **只靠 `network.allowed_domains` 扩到 bash。** 没有 OS 围栏时，解析不到的 URL 直接出网。
- **always 只写 renderer zustand persist。** CLI 与代理进程读不到；CLI 今天的 always 还是会话级。
- **v1 TLS MITM 做哨兵。** 要在沙盒里灌 CA，钉扎的 npm/企业代理会红，成本超过本季这张单。
- **预置 registry 种子白名单。** 放宽默认，另开拍板；本 ADR 不带。

## 后果

得到：

- 刀 0 立刻补上 bash 侧云元数据/内网这条与 Claude auto-mode 对齐的预检。
- 刀 2 让 `gh`/`npm`/`curl -H "$TOKEN"` 在网络命令里重新可用，同时非网络命令仍打印引用串。
- 刀 3 把「放网」从命令名布尔收成目的地审批，且 python 夹带出网会被 profile 挡住。

代价：

- 第一次访问新 hostname 要出卡（`npm install` 至少一张）。
- 网络命令这一跳的 bash env 里仍有明文（寿命=这一跳）。
- ssh 在目的地策略打开后默认连不上（环回-only）。
- Windows 刀 3 弱一档。
- 多一个随宿主活着的本地代理；端口/socket 泄漏只听本机，但仍是新攻击面，绑定与权限必须进施工单的反向变异。

不做：云端执行形态、SSH SOCKS、TLS MITM、eTLD+1 合并审批、给 python/node 单独开出网名单。

## 施工拆单（ADR 过后开，本单不动）

| 单 | 内容 | 门 | 依赖 |
|---|---|---|---|
| 刀 0 预检 | `commandParse` 抽 host；`commandSafety` 接 `isPrivateOrLocalHost`；私网/元数据 high 确认；`nc`/`ncat`/`netcat` 进抽取名单（不必先改 `NETWORK_COMMANDS`） | 单测 + 反向变异（命令文本里加 `curl http://169.254.169.254/` 必须 high） | — |
| 刀 2 哨兵 | `createEvalSafeShellEnv` 注入 `secureref:env.*`；网络命令回填；解失败不 exec；错误不带真值 | 单测 + 反向变异（把 lookup 打空 → 命令不跑且日志无真值） | — |
| 刀 3 代理 | egress proxy + seatbelt/bwrap 环回例外 + 审批卡 + `approved_domains` + 企业表天花板 + 元数据硬拒绝 | 集成测试（sandbox wrap：直连公网失败、经代理只放行已批 hostname）+ 反向变异（摘掉 `(deny network*)` / 改回 `--share-net` 必须红） | N-SANDBOX-DEFAULTON |

## 事实锚点

- `src/host/sandbox/networkPolicy.ts:1-26` 25 个命令；`:34-42` 命中即整条放网
- `src/host/sandbox/seatbelt.ts:167-172` 关网 = `(deny network*)`；开网 = 不写这条（整网）
- `src/host/sandbox/bubblewrap.ts:309-317` `--unshare-all` 下开网 = `--share-net`
- `src/host/tools/modules/shell/bash.ts:60-90` strip；`:654-688` `shouldSandbox` 与 `allowNetwork`
- `src/shared/constants/sandbox.ts:15` `OS_SANDBOX.ENABLED` 默认 false
- `src/host/security/policyEnforcer.ts:75-118` `checkNetwork`；`src/host/tools/toolExecutor.ts:2549-2551` 只对 network+url
- `src/host/utils/envSecretFilter.ts:40-48,82-101` 按名 strip
- `src/host/mcp/secretRef.ts:39-44,75-104` encode / fail-closed resolve；消费方 `mcpSecretResolver.ts:50-65`
- `src/host/security/ssrfGuard.ts:17-45` `isPrivateOrLocalHost`；7 个 import 见上文
- `src/host/security/commandSafety.ts:403-452` `DANGEROUS_PATTERNS`（无私网 URL）
- `src/renderer/stores/permissionStore.ts:89-97,138-150` `network:${hostname}` 的 session/always 记忆（UI 层，不是出网闸）
- `src/shared/contract/permission.ts:35-40` `ApprovalLevel`；`:50-67` 无审批 UI 的 fail-closed code

## as-built 与任务书不符之处

1. 网络策略文件在 `src/host/sandbox/networkPolicy.ts`，不在 `src/host/security/networkPolicy.ts`。
2. `NETWORK_COMMANDS` 25 项，不是 27；无 `nc`/`netcat`。D08-13 要抽 nc 目标，刀 0 仍抽，但今天沙盒放网名单不含它（沙盒开着时 nc 本身无网）。
3. 其余锚点（strip 非 mask、`allowed_domains` 不罩 bash、SSRF 七个 fetch 消费方、OS 沙盒默认关）与任务书一致。
