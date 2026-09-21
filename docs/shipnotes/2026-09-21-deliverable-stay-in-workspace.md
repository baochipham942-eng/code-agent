# Ship note · 2026-09-21 · 产物收敛回工作区（#1997，N-DELIVERABLE-STAY-IN-WORKSPACE）

工单：pptx/docx 产物逃逸工作区——夜跑 37 个文件落 `~/Downloads`（含 3 个任务声称交付的
pptx），HOME 根 1 个 docx；模型自创工作区兄弟目录（`ws/gdp-772e7524` 截成 `ws/gdp-7724`）
也能写成功。产物不在工作区 = 没交付，外部评分/巡检全盘找不到文件。

## 根因

1. **导出机制**：agent 工具 `proposeSlidesOps` 生成 pptx 走 `handleGenerateSlidesDeck` →
   `handleSaveBinaryToDownloads`，硬编码 `os.homedir()/Downloads`（`src/host/ipc/workspaceSaveExport.ts`）。
2. **沙箱写根**：bash 工具在 `workspaceScope` 缺省时，seatbelt 写根默认 = cwd 子树；
   而默认会话 cwd = HOME（`agentOrchestrator.initializeWorkDirectory`）→ 整棵 HOME 可写，
   run 授权边界 `ctx.workspace`（如 `~/ws/gdp-772e7524`）并没有成为写边界。

## 改动

- `src/host/ipc/workspaceSaveExport.ts`：抽出 `uniqueTargetPath` 共用核；新增
  `handleSaveBinaryToDirectory`（与 Downloads 版同源：防穿越、重名 -N 后缀、base64 不带编码）。
- `src/host/ipc/workspaceSlidesExport.ts`：`GenerateSlidesDeckPayload` 新增 `outputDir`；
  在场走 `handleSaveBinaryToDirectory`（agent 产物），缺省仍走 Downloads（用户主动导出，行为不变）。
- `src/host/tools/modules/design/proposeSlidesOps.ts`：传 `outputDir: ctx.workingDir`，
  deck 落当前工作区；结果文案改为带实际路径。
- `src/host/tools/modules/shell/bash.ts`：`workspaceScope` 缺省且 `ctx.workspace` 严格落在
  cwd 内时，seatbelt `readWriteRoots` 收紧到 `[workspace]`。只收紧不放宽：
  `workspace == cwd` 或 workspace 在 cwd 外时维持既有默认 `[workingDirectory]`；
  TMPDIR / /dev / npmHome 等既有白名单不动，工作区内写不受影响（真机 sandbox-exec e2e 验证：
  工作区内写 rc=0，兄弟目录与 Downloads 写 rc=1）。
- `src/host/prompts/identity.ts`：Task Execution 增第 4 条「产物落工作区相对路径，
  不主动写 ~/Downloads / 区外绝对路径」（常驻层 token 预算 3100 内，压缩后净增 ~1 token）。
- `src/host/agent/messageHandling/contextBuilder.ts`：保存位置询问把「默认工作区」列为
  默认选项并注明产物默认位置。`PROMPT_VERSION` sys-v53 → sys-v54。

## 用户面行为边界

用户主动点的导出（sidebar 会话导出、设计面板导 PPTX/PDF、Doctor 导出）仍落 ~/Downloads——
那是「下载」语义，不是 agent 交付语义，本单不动。

## 反向变异

1. bash.ts 去掉 `?? workspaceConfinedRoots`（退回旧写根）：

```
 FAIL  tests/unit/tools/modules/shell/bash.test.ts > bashModule OS 沙箱 gating（bypassPermissions） > #1997：workspaceScope 缺省且 workspace 在 cwd 内 → 写根收紧到 workspace 子树
AssertionError: expected "vi.fn()" to be called with arguments: [ 'echo plain-output', …(1) ]
```

2. workspaceSlidesExport.ts 去掉 outputDir 路由（一律落 Downloads）：

```
 FAIL  tests/unit/ipc/workspaceDesignMedia.idempotency.test.ts > handleGenerateSlidesDeck commandId 幂等（付费配图收口） > #1997：outputDir 在场 → 落 handleSaveBinaryToDirectory（工作区），不走 Downloads
```

## 测试证据

- `npm run typecheck`：绿。
- `npx vitest run tests/unit/ipc/workspaceSaveExport.test.ts tests/unit/tools/modules/design/proposeSlidesOps.test.ts tests/unit/ipc/workspaceDesignMedia.idempotency.test.ts tests/unit/host/sandbox tests/unit/tools/modules/shell/bash.test.ts tests/unit/prompts tests/unit/agent/contextBuilder.test.ts tests/unit/agent/contextAssembly.test.ts`：37 文件 528 passed / 2 skipped。
- `npx vitest run tests/integration/sandbox`（真 sandbox-exec）：16 passed / 6 skipped。
- 真机 e2e（临时测试，验后删除）：假 HOME 在 TMPDIR 外，`wrapCommand` + 新写根 →
  工作区内 `ok.txt` 写入 rc=0，`ws/gdp-7724.txt` / `Downloads/x.txt` 写入 rc=1 且文件不存在。
- 新增/变更测试计数：workspaceSaveExport +3、proposeSlidesOps +1、idempotency +1、
  bash +3、seatbeltWriteConfinement +2（新文件）。
- gates:fast：`✓ gates:fast passed required local preflight. schema=2 receipt=c05684b7-b7ae-4914-abf3-9453a0cd4dac`（HEAD/tree 绑定的最新回执以 ship pr 交付前重跑为准）

证据档位：static-contract + hermetic-protocol + os-jail e2e（darwin seatbelt 真机）


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=805559ce90124ba6cdae8615cf36f406d263d80b base=a5ca056be0b1803312259441b9837698368ad8ea receipt=f227a95d-fa0e-4251-b2ff-d549eba99574


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=e8d42be2b8fd9dff269e05f632632621aa78485b base=7f353a4fec5d2526531dbbf93c5f086fec8ad664 receipt=6fe50898-3d00-4935-b099-f44cce5a20f4
