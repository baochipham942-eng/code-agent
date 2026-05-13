# `/doctor` 诊断命令实施计划

> 分支：`feature/doctor-command`
> 起点 commit：`9f9d4e33 feat(diagnostics): extract doctor types and environment checks`
> Step 1 已落地，本计划从 **Step 2** 开始。

---

## 1. 目标 & 非目标

### 目标

- 提供一个用户可触发的 `/doctor` 命令，跨 **CLI + GUI** 一键聚合 9 类健康检查。
- 用同一个聚合层 (`doctorRunner.runDoctor()`) 输出统一的 `DoctorReport`，避免 CLI / GUI 双份逻辑。
- 启动时在 GUI 给出"我是最新版"或"有新版可更新"的轻提示，不打断工作流。
- 复用现有底层能力（Provider 连通性测试、Provider 健康监控、MCP 状态、Hooks 校验、版本检查、环境检查），**禁止重写**。
- LAZY/未配置类资源在报告里以 `skip` 状态出现，不计入 fail。

### 非目标

- 不在 `/doctor` 内做修复动作（自动 reconnect / 自动重装 MCP 等）；只诊断 + 给 suggestion。
- 不引入新的 IPC domain；在 `domain:provider` 的 `run_diagnostics` action 上做向下兼容扩展，必要时新增 `run_doctor` action。
- 不替换 `ProviderDoctorDialog`，只把它升级为消费新的 `DoctorReport`（仍保留入口）。
- 不动 update server 本身，只做"启动调用 + 顶部 toast"。
- 不做 CI/远程 telemetry，所有 check 本地完成。

---

## 2. 验收标准

1. CLI 中输入 `/doctor`，30s 内返回结构化报告，覆盖 9 个 category，至少 8 个有结果（version 项允许网络失败时降级为 `warn`）。
2. GUI 中执行 `/doctor`（设置入口或 chat 内 slash）调出 `ProviderDoctorDialog`，渲染同一份 `DoctorReport`，pass/warn/fail/skip 计数与 CLI 一致。
3. MCP server 状态为 `lazy` 时该项标 `skip` 并附说明（"尚未触发首次调用"），**不**计入 fail。
4. App 启动 8s 后（沿用 `UI.STARTUP_UPDATE_CHECK_DELAY`）若 `hasUpdate=false`，顶部出现一次"已是最新版本 vX.Y.Z" toast，2s 后自动消失；若 `hasUpdate=true`，复用现有 update banner。
5. 整个调用链 `npm run typecheck` 通过；新增聚合层有单测覆盖正常路径 + MCP lazy 路径 + 网络超时降级路径。
6. `9f9d4e33` 引入的 `runDiagnostics()`（向后兼容 shim）仍可被 `ProviderDoctorDialog` 旧路径调用，不破坏现有"诊断"按钮。

---

## 3. 现状调研

### 3.1 验证用户给出的底层现状

| 现状描述 | 验证结果 |
|---|---|
| `provider.ipc.ts` 有 `run_diagnostics` + `getHealthStatus` action | ✅ `src/main/ipc/provider.ipc.ts:223,227` |
| `doctor.ipc.ts` 有 DB / Node / Config / 磁盘 4 个 check | ✅ 已搬迁，现在在 `src/main/diagnostics/checks/environment.ts:12-100`；`doctor.ipc.ts` 是 49 行的 shim |
| API 连通性测试（Claude/Gemini/OpenAI 兼容）+ `AUTH_FAILED`/`RATE_LIMITED` 结构化错误 | ✅ `provider.ipc.ts:94-203`，`handleTestConnection` 已 export |
| Provider 健康监控 P50 + 错误率 | ✅ `src/main/model/providerHealthMonitor.ts:12-95`，导出 `ProviderHealth { status, latencyP50, latencyP95, errorRate, consecutiveErrors }` |
| MCP server 状态 map：`disconnected/connected/lazy`，`getServerStates()` 比 `getStatus()` 更精细 | ✅ `mcpClient.ts:152`，类型 `MCPServerStatus = 'lazy' \| 'disconnected' \| 'connecting' \| 'connected' \| 'error'`（`src/main/mcp/types.ts:134`）— 注意**还多了 `connecting` 和 `error` 两个用户没提的中间态** |
| Hook 配置语法校验 | ✅ `src/main/hooks/configParser.ts:129 parseHooksConfig` + `:278 validateHooks` |
| `updateService.checkForUpdates()` 已存在 | ✅ `src/main/services/cloud/updateService.ts:144` |
| `configService` 友好降级 | ✅（沿用现成） |

### 3.2 现状描述里的小偏差

1. **MCP 状态不只 3 种**：用户给的"disconnected/connected/lazy"，实际还有 `connecting`、`error`。聚合时 `connecting` 要按 `warn`、`error` 按 `fail`，否则会漏 fail。
2. **`runDiagnostics()` 已被打上 `@deprecated`**：Step 1 的 shim 注释明确说"新代码请直接调用 `runDoctor()`"，但 `doctorRunner.ts` **还没创建**，这是 Step 2 的核心交付物。Plan 的 Step 2 必须建这个文件，不要继续扩 `runDiagnostics`。
3. **CLI 没有 doctor slash command**：`src/cli/commands/chat.ts:378` 走的是 `getCommandRegistry()`，但 `src/shared/commands/definitions/` 下 6 个文件里没有 doctor 命令；要新增 `doctorCommands.ts` 并加入 `shared/commands/index.ts`。
4. **GUI 已有 `ProviderDoctorDialog`**：`src/renderer/components/features/settings/ProviderDoctorDialog.tsx`，目前从设置面板 ModelSettings 入口调起；本 plan 不重写，只让它消费新报告。
5. **App.tsx 已有 startup update check**：`src/renderer/App.tsx:253-275`，但只在"有更新"时弹 banner，没有"已是最新"的反馈 — Step 5 在此基础上加一个轻量 toast，不改 banner 逻辑。

### 3.3 对 commit `9f9d4e33` 的评估

接受 `9f9d4e33` 作为 Step 1，**不要求 revert**。可改进点（后续可单独 PR，**不阻塞本 plan**）：

- `DoctorCategory` 用字符串字面量联合，未来加新分类要改 type 又要改报告渲染；可在 Step 2 顺手加一个 `DOCTOR_CATEGORIES` 常量数组做单一来源。
- `DiagnosticItem = DoctorItem` 别名是临时桥；Step 6 收尾时改掉 `ProviderDoctorDialog.tsx` 的引用后可清掉。
- `checkDiskUsage()` 当前只 `stat` 配置目录就标 pass，**没真正算磁盘剩余**；不算回归（原来也是这样），但 Step 7 测试计划里会标记为已知不足。

---

## 4. 设计方案

### 4.1 聚合层 API

新增 `src/main/diagnostics/doctorRunner.ts`：

```ts
export interface RunDoctorOptions {
  /** 跳过需要网络的 check（network / version）。CLI 默认 false，启动检查默认 true */
  skipNetwork?: boolean;
  /** 单项 check 超时，默认 10s */
  perCheckTimeoutMs?: number;
}

export async function runDoctor(opts?: RunDoctorOptions): Promise<DoctorReport>;
```

内部按 category 串行调度（保留可观测的 `durationMs`），每个 check 用 `Promise.race` 加超时；超时统一返回 `warn` + suggestion "检查超时，可能是网络/外部进程响应慢"。

### 4.2 新增 checks（5 个文件）

| 文件 | 内容 | 复用 |
|---|---|---|
| `src/main/diagnostics/checks/network.ts` | 对**已配置** provider 跑 `handleTestConnection`；未配置的标 `skip` | 复用 `handleTestConnection`（已 export） |
| `src/main/diagnostics/checks/providerHealth.ts` | 调 `getProviderHealthMonitor().getHealthMap()`，把 `healthy/degraded/unavailable/recovering` 映射为 pass/warn/fail/warn | 复用 `providerHealthMonitor` |
| `src/main/diagnostics/checks/mcp.ts` | `getMCPClient().getServerStates()` → 5 态映射：`connected=pass`, `lazy=skip`, `disconnected=warn`, `connecting=warn`, `error=fail` | 复用 mcpClient |
| `src/main/diagnostics/checks/hooks.ts` | 调 `parseHooksConfig` 校验 global + project 两个 settings 文件，把每个解析错误回报为 1 个 `warn` item | 复用 configParser |
| `src/main/diagnostics/checks/version.ts` | 调 `updateService.checkForUpdates()`；hasUpdate=true→warn，false→pass，网络失败→warn | 复用 updateService |

### 4.3 IPC 扩展

在 `provider.ipc.ts:213` 的 switch 加一个 action：

```ts
case 'run_doctor': {
  const data = await runDoctor(payload as RunDoctorOptions | undefined);
  return { success: true, data };
}
```

`run_diagnostics` 保留不动 — `ProviderDoctorDialog` 旧调用方走老路径，新调用方（slash command）走 `run_doctor`。

### 4.4 Slash command 注册

新增 `src/shared/commands/definitions/doctorCommands.ts`：

```ts
export const doctorCommand: CommandDefinition = {
  id: 'doctor',
  name: '系统诊断',
  description: '运行 9 类健康检查（环境/数据库/网络/MCP/Hooks/版本…）',
  category: 'system',
  surfaces: ['cli', 'gui'],
  aliases: ['diagnose'],
  handler: async (ctx, args) => { /* 调 ipc bridge → run_doctor → 格式化输出 */ },
};
```

在 `shared/commands/index.ts:14` 的 barrel 里 export 并加入 `initializeCommands()` 的 allDefs 列表。

CLI 表现：以 box-drawing 表格按 category 分段打印；fail 红、warn 黄、pass 绿、skip 灰。

GUI 表现：handler 触发 zustand action 打开 `ProviderDoctorDialog`，dialog 内自动 `run_doctor`（带 spinner）。

### 4.5 启动"我是最新版" toast

`src/renderer/App.tsx:253` 既有逻辑里，`checkForUpdates` resolve 后：

- `hasUpdate=true` → 走现有 banner（不动）
- `hasUpdate=false` → `useToast().info("已是最新版本 v" + currentVersion, { duration: 2000 })`
- 失败 → 静默（写 logger.warn）

只在**冷启动一次**触发；同一 session 内重复 check 不再弹。

### 4.6 输出格式示例（CLI）

```
/doctor running...

╭─ Environment ──────────────────────────────────────────╮
│ ✓ Node.js v20.11.0                                     │
│ ✓ Config directory   /Users/linchen/.code-agent        │
╰────────────────────────────────────────────────────────╯
╭─ Network ──────────────────────────────────────────────╮
│ ✓ deepseek    188ms                                    │
│ ⚠ moonshot    timeout (10s)  → 检查代理设置             │
│ - openai      skipped (未配置 API Key)                  │
╰────────────────────────────────────────────────────────╯
╭─ MCP ──────────────────────────────────────────────────╮
│ ✓ filesystem        2 tools                            │
│ - firecrawl         lazy (尚未触发首次调用)              │
│ ✗ github            error: ENOTFOUND                   │
╰────────────────────────────────────────────────────────╯
...
Summary: 12 pass / 2 warn / 1 fail / 3 skip   ⏱ 2.3s
```

---

## 5. 文件改动清单

### 新增

- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/doctorRunner.ts` — 聚合层 `runDoctor()` + 超时 wrapper。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/checks/network.ts` — 已配置 provider 的连通性 check。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/checks/providerHealth.ts` — provider 健康状态 check。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/checks/mcp.ts` — MCP server 状态 check。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/checks/hooks.ts` — Hook 配置语法 check。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/checks/version.ts` — 版本 check。
- `/Users/linchen/Downloads/ai/code-agent/src/shared/commands/definitions/doctorCommands.ts` — slash command 定义。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/__tests__/doctorRunner.test.ts` — 单测。

### 修改

- `/Users/linchen/Downloads/ai/code-agent/src/main/ipc/provider.ipc.ts` — switch 增加 `run_doctor` action（不删 `run_diagnostics`）。
- `/Users/linchen/Downloads/ai/code-agent/src/shared/commands/index.ts` — 注册 `doctorCommands`。
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/settings/ProviderDoctorDialog.tsx` — 切换数据源到 `run_doctor`，按 9 category 分段渲染（保留旧 prop 调用入口）。
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/App.tsx` — 启动 update check resolve 后增加"已是最新版"toast 分支。
- `/Users/linchen/Downloads/ai/code-agent/src/main/diagnostics/types.ts` — 新增 `RunDoctorOptions` export（顺手补 `DOCTOR_CATEGORIES` 常量）。

### 不动

- `src/main/ipc/doctor.ipc.ts`（保持 49 行 shim 不变）
- `src/main/model/providerHealthMonitor.ts`
- `src/main/mcp/mcpClient.ts`
- `src/main/hooks/configParser.ts`
- `src/main/services/cloud/updateService.ts`

---

## 6. 实施步骤（Step 2 起）

| Step | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **2** | 新增 5 个 check 文件 + `doctorRunner.ts` + `RunDoctorOptions` 类型 | Step 1 | 单元跑通 `runDoctor()` 返回 9 category，typecheck pass |
| **3** | 在 `provider.ipc.ts` 加 `run_doctor` action，更新 `ProviderDoctorDialog` 数据源 | Step 2 | 设置面板的"诊断"按钮渲染 9 段，旧 4 项功能不丢 |
| **4** | 新增 `doctorCommands.ts`，注册到 `initializeCommands()` | Step 2 | CLI 中 `/doctor` 调用打印表格，GUI 中 `/doctor` 弹 dialog |
| **5** | `App.tsx` 启动 toast 分支（"已是最新版"） | 独立 | 启动 8s 内出现 toast；有更新时不出 toast |
| **6** | 收尾：删 `DiagnosticItem` 别名引用，把 `ProviderDoctorDialog` 内残留的 `DiagnosticItem` 改为 `DoctorItem` | Step 3 | grep `DiagnosticItem` 无业务引用，types.ts 别名标 deprecated 注释 |
| **7** | 单测 + e2e + 文档 | Step 2-4 | 见第 8 节 |

每个 Step 一个 commit，commit message 形如 `feat(diagnostics): step N - <一句话>`。

---

## 7. 风险 & 缓解

| 风险 | 触发场景 | 缓解 |
|---|---|---|
| **MCP lazy 误判为 fail** | 用户首次安装，所有 MCP 都是 `lazy` 状态，naive 聚合会把整份报告搞成红的 | `mcp.ts` 显式把 `lazy` 映射为 `skip` 不计入 fail；`connecting` 也按 `warn` 不按 fail；测试用例必须覆盖全 lazy 场景 |
| **网络 check 阻塞 CLI** | 国际 provider 不走代理时单个 fetch 卡满 30s + 5 个 provider 串行 = 150s 用户以为卡死 | `runDoctor` 默认 `perCheckTimeoutMs=10000`；超时返回 `warn` 不返回 `fail`；network category 内 5 个 provider 用 `Promise.allSettled` 并行 |
| **`run_doctor` 与 `run_diagnostics` 双入口分裂** | 旧入口长期不下线导致两条诊断结果不一致 | Step 6 把 `runDiagnostics` 改成内部委托 `runDoctor({ skipNetwork: true })` 的过滤版本（只回 environment + database + disk），保证单一真理来源 |
| **启动 toast 噪音** | 每次启动都弹"已是最新版"很烦 | 仅当用户在设置里 `autoCheckOnStartup=true` 时弹；duration=2000ms；移动端/窄窗时改为状态栏小图标（出本期 plan 范围，标 TODO） |
| **Step 1 类型别名误用** | `DiagnosticItem` 别名让 IDE 自动补全有歧义，新代码可能继续用旧名 | 在 `types.ts` 别名上加 `/** @deprecated 使用 DoctorItem */`；Step 6 grep 清除 |

---

## 8. 测试计划

### 单测（vitest）

`src/main/diagnostics/__tests__/doctorRunner.test.ts`：

1. **正常路径**：mock 5 个 check 全 pass → summary `{pass:9, warn:0, fail:0, skip:0}`。
2. **MCP 全 lazy**：mock `getServerStates()` 返回 3 个 lazy server → mcp category 3 项 skip，summary fail=0。
3. **网络超时**：mock `handleTestConnection` hang 15s + `perCheckTimeoutMs=1000` → 对应项 warn，整体不抛。
4. **版本网络失败**：mock `checkForUpdates` reject → version 项 warn 而非 fail。
5. **Hook 配置非法 JSON**：mock 一个坏 settings.json → hooks 项 warn 包含解析错误位置。

### 手动 e2e

| 场景 | 步骤 | 期望 |
|---|---|---|
| CLI 全绿 | 配 1 个 deepseek key、跑 `/doctor` | 表格 9 段，summary `12 pass / 0 warn / 0 fail / 3 skip` |
| GUI 入口 | 在 chat 输入 `/doctor` | 弹 `ProviderDoctorDialog`，spinner→渲染分段结果 |
| 启动 toast | `npm run build:web && cargo tauri dev` 启动 | 8s 后顶部 toast "已是最新版本 v0.16.74"，2s 消失 |
| MCP lazy | 全新机器首启 | mcp 段 3 项 skip，summary fail=0 |
| 断网 | 关闭 Wi-Fi 跑 `/doctor` | network/version 全部 warn 而非 fail，整体可读 |

### 回归

- `npm run typecheck` 必须通过（每个 Step 提交前都跑一次）。
- 设置面板原"诊断"按钮跑出来的 4 项结果与改造前一致（snapshot 比对）。

---

## 9. 工作量估算

| Step | 估时 |
|---|---|
| Step 2（5 个 check + runner + types） | 4h |
| Step 3（IPC action + Dialog 改造） | 2.5h |
| Step 4（slash command + CLI 渲染） | 2.5h |
| Step 5（启动 toast） | 0.5h |
| Step 6（类型收尾 + 别名清理） | 0.5h |
| Step 7（单测 + e2e + 文档） | 2h |
| **合计** | **12h**（净开发；不含 review 与 ship 沟通） |

预计 1.5 个工作日完成；走渐进式 commit，任一 Step 失败可回滚到上一 commit 不影响主分支。
