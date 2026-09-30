# 三层封闭回放证据

hermetic-protocol 原先只咬「发给假模型的字节」。渲染投影坏了，或者文件没落盘，协议层仍可能全绿。一条回放用例要拆成三层，每层自己的断言、自己的基线；一层红，另外两层不许跟着红，也不许用绿把这一层盖住。

当前只钉一条已有用例：`write-file`。它已有 request-replay 快照，假模型发出一次 Write，真工具把便签写入工作区，账本留下用户句、工具调用、工具结果和收尾应答。

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
| `artifacts[]` | 假模型 Write 路由 `persistSnapshotReplayWriteArtifact` 重放后的文件 | 只留文件名、sha256、字节数，不留绝对路径 |
| `approvals[]` | 账本消息 metadata 与工具结果 metadata 里的审批决定 | 按 toolCallId、工具名、决定排序；没有就空数组 |

`write-file` 的写入发生在录制工作区里，账本没有停车审批记录，所以 `approvals` 是空数组。空数组也是终态：以后多出一条审批，这一层会红。产物哈希来自假模型那一次落盘的重放，不是把账本里的参数再哈希一遍。

独立变红：在 `persistSnapshotReplayWriteArtifact` 里跳过那一次 `atomicWriteFile`。协议层重推导响应不调用它，渲染层只读账本。

## 变异矩阵

| 只破坏 | 渲染层 | 协议层 | 持久层 |
| --- | --- | --- | --- |
| 改投影标签（`humanizeToolStep` 的 Write 句） | 红 | 绿 | 绿 |
| 改请求字节（`IDENTITY`） | 绿 | 红 | 绿 |
| 跳过假模型落盘 | 绿 | 绿 | 红 |

三层各是一个 `it`。比较的输入互不包含：渲染层不读身份声明、不写盘；协议层不跑投影、不写盘；持久层不跑投影、不重建请求字节。
