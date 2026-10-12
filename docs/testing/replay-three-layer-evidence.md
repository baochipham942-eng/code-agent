# 三层封闭回放证据

hermetic-protocol 原先只咬「发给假模型的字节」。渲染投影坏了，或者文件没落盘，协议层仍可能全绿。一条回放用例要拆成三层，每层自己的断言、自己的基线；一层红，另外两层不许跟着红，也不许用绿把这一层盖住。

当前只钉一条已有用例：`write-file`。它已有 request-replay 快照，假模型发出一次 Write，真工具把便签写入工作区，账本留下用户句、工具调用、工具结果和收尾应答。持久层的产物哈希来自把账本里这次 Write 的参数重放进真 Write 工具执行器——与录制会话同一条产品路径，不是旁路自写。

## 基线放哪

沿用 `packages/internal/evaluation-center/snapshots/request-replay/`。协议层仍是用例目录里的 `canonical-request.json` / `expected-response.json`。渲染层和持久层是同目录下的旁路文件，与用例目录同级：

- `write-file.render.json`
- `write-file.state.json`

`npm run acceptance:snapshot-replay:record` 在录完 `write-file` 后写出这两份。同步门 `scripts/ci/snapshot-replay-sync-gate.mjs` 把协议层语料、`.render.json`、`.state.json` 都算「快照更新」：敏感面前缀（含 `src/host/prompts/`、`src/host/testing/e2e/`）有 diff 而三类文件都没动，门红。`write-file` 缺任一旁路也红。消费方是 `.github/workflows/swarm-ci.yml` 的 `Snapshot replay baseline sync gate`（`npm run check:snapshot-replay-sync`），路径过滤包含 `snapshots/**` 以及这两类旁路。

## 渲染层

比较对象：把规范化账本送进现有呈现函数，得到用户会看见的投影，再与 `write-file.render.json` 逐字节比较。链路是 `hydrateToolCallResults` → `projectTurns` → `humanizeToolStep`（中文步骤句）→ `buildTurnFileChanges`（路径、增删行、是否新文件）。不截图，不收系统提示，不收节点 id 和时间戳。路径沿用账本里已经擦过的 `<RECORD_DATA_DIR>`，展示句再走 `formatDisplayPath`。

独立变红：改 `humanizeToolStep` 里 Write 分支返回的那句标签。协议层不调用它，持久层不调用它。

## 协议层

比较对象：按 `index.json` 的 turn 顺序，用当前代码 `reconstructRequest` 重建请求，与 `canonical-request.json` 逐字节比较；再用当前假模型重推导响应，与 `expected-response.json` 逐字节比较（`replaySnapshotCase`）。另外，每条请求解开后的 canonical 正文必须仍包含 `src/host/prompts/identity.ts` 里当前的 `IDENTITY`。回放重建不重读提示词源码，所以只改身份声明时，已录字节仍可能对得上；包含检查会红。身份声明在敏感面前缀 `src/host/prompts/` 上。

独立变红：改 `IDENTITY` 的正文。渲染层只看账本里的用户句、助手句和工具步骤，持久层只看消息条数、末角色、产物哈希和审批，都不读这份声明。

## 持久层

比较对象与 `write-file.state.json` 逐字节比较，四项都要在：

| 字段 | 比什么 | 怎么归一 |
| --- | --- | --- |
| `session.messageCount` / `lastRole` | 规范化账本的条数和最后一条角色 | 时间戳、会话 id 不进这一层 |
| `artifacts[]` | 把账本里录下的 Write 调用参数（`file_path` 取 basename 进回放临时工作区、`content` 用录下的正文）喂给**真 Write 工具执行器**（`writeModule` → `atomicWriteFile` 产品路径）后实际落盘的文件 | 留文件名、`tool`、落盘 sha256、字节数、请求正文 sha256；不留绝对路径 |
| `approvals[]` | 账本消息 metadata 与工具结果 metadata 里的审批决定 | 按工具名、终局排序；没有就空数组 |

产物哈希不是自写自哈希：持久层不自己把常量写进临时文件再算哈希，而是走与录制会话完全相同的工具执行链，哈希**工具真实写出的字节**，并要求落盘哈希等于账本请求正文的哈希（`sha256 === requestSha256`）。Write 工具执行失败、没写、写错字节（哪怕只丢一个字节）都在这一层红，错误信息分别可区分（执行失败 / 未落盘 / 落盘与请求不一致）。

会话与审批的**落库对账**发生在录制期：录制脚本录完用例后从真实会话库读回终态（session messages 表 + 权限决策账本），与内存账本互相咬合——末角色必须一致、条数必须等于账本去掉用户句后的条数、权限决策必须全是 allow。条数差一条用户消息是已知 harness 缺口（测试适配器不落用户句，生产 orchestrator 落），所以基线字节仍由可重推导的账本投影生成，会话库只做录制期对账；等适配器补上落库，对账会变红，提醒把基线改成直接吃会话库。回放侧是 keyless 纯文件路径（无 DB），这是基线必须可从已提交语料重推导的根本约束。

`write-file` 的写入由录制环境的免审批路径放行（权限决策账本里是一条 `Write: allow`），账本消息 metadata 不携带该决定，所以回放侧 `approvals` 投影是空数组。空数组也是终态：以后账本里多出一条可重推导的审批，这一层会红。

独立变红：在 `src/host/tools/utils/atomicWrite.ts` 的 `atomicWriteFile` 里让产品写入丢一个字节。协议层重推导响应不写盘，渲染层只读账本。

## 变异矩阵

| 只破坏 | 渲染层 | 协议层 | 持久层 |
| --- | --- | --- | --- |
| 改投影标签（`humanizeToolStep` 的 Write 句） | 红 | 绿 | 绿 |
| 改请求字节（`IDENTITY`） | 绿 | 红 | 绿 |
| 产品写入丢一个字节（`atomicWriteFile`） | 绿 | 绿 | 红 |
| 产品写入整个跳过（`atomicWriteFile`） | 绿 | 绿 | 红 |

三层各是一个 `it`。比较的输入互不包含：渲染层不读身份声明、不写盘；协议层不跑投影、不写盘；持久层不跑投影、不重建请求字节。
