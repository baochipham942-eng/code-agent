# OS 沙箱接入 bypassPermissions 档 — 实施方案

- **日期**: 2026-05-25
- **分支**: `feat/sandbox-bypass`(待开）
- **状态**: 待执行
- **作用域**: 仅 `bypassPermissions`（YOLO）权限档的 bash 执行接入 OS 级沙箱；其余档位行为零变化

---

## 1. 背景与问题

项目 `src/main/sandbox/` 下已有一套**自研、完整但未接线**的 OS 级沙箱（约 40KB，2026-05-20 最后改动）：

- `seatbelt.ts`（15.9KB）— macOS `sandbox-exec` 包装 + `generateProfile()` 生成 seatbelt profile
- `bubblewrap.ts`（12.5KB）— Linux `bwrap` 包装
- `manager.ts`（11.3KB）— 统一入口 `executeInSandbox()` / `SandboxManager`
- `index.ts` — 桶导出

**关键事实（2026-05-25 grep 验证）**：

- `executeInSandbox` 全项目**零调用**（`manager.ts:445` 定义 + `index.ts:28` re-export，无 call site）
- `src/main/tools/` 无任何文件 import sandbox 模块
- bash 实际执行走 `src/main/tools/modules/shell/bash.ts:201` 的 `spawn(command, { shell: true })` 直连 `/bin/sh`，**绕过沙箱**

即：沙箱是死代码/预留。当前命令执行是**应用层审批卡口**（6 档权限模式 + 策略规则引擎 + 危险命令正则黑名单 `commandPolicy.ts` + 多 agent 拓扑守卫 `guardFabric.ts`），**无 OS 级隔离在生效**。

**两个最薄弱环节**（OS 沙箱正好兜底）：

1. `bypassPermissions` 一旦用户批准就完全跳过后续检查（`modes.ts:133`）
2. 危险命令正则黑名单可被混淆绕过（`cu''rl|sh`、变量间接、base64），`commandPolicy.ts` 注释自承认不抗混淆

本方案只解决第 1 个环节最危险的场景：**给 YOLO 档加内核级 blast-radius 兜底**。

---

## 2. 设计决策与参考

### 2.1 不接 Anthropic ASRT，接自己已有的沙箱

`@anthropic-ai/sandbox-runtime`（ASRT）与自研沙箱**底层技术完全相同**（macOS = seatbelt/sandbox-exec，Linux = bwrap）。自研已付出 ~90% 成本（profile 生成 + 平台检测都写好了），ASRT 只省"维护边界 case"却让自研作废。**先接自己的；跑顺后维护不动再考虑迁 ASRT。**

> ASRT 是 `anthropic-experimental` 实验项目（v0.0.30，stdio inherit 的进程包装器模式），Linux 需系统装 `bwrap` + `socat`。Alma 桌面应用即把 ASRT 打进 Electron `node_modules` 使用。

### 2.2 核心架构选择：命令包装器，不是缓冲执行器 ← ASRT 参考所得

读 ASRT 源码后修正的关键决策。ASRT 的做法是：**把命令转换成一条带沙箱前缀的 shell 命令**（`sandbox-exec -f <profile> /bin/sh -c "<原命令>"`），然后用 `stdio: 'inherit'` spawn，并转发 SIGINT/SIGTERM 给子进程（`cli.js:118,140`）。因为 stdio 直通 + 信号转发，**流式 / 交互 / 长跑 / 后台 / 中断全是免费的**。

而本项目自研的 `seatbelt.execute()`（`seatbelt.ts:350`）选了**缓冲模型**（`proc.stdout.on('data')` 累加成字符串，`close` 才 resolve，无 abortSignal、无流式回调、非零退出不抛错）。

bash 前台执行器 `runForegroundCommand`（`bash.ts:176-319`）已经具备：
- 流式输出 → `emitToolOutputDelta`（`bash.ts:247-263`）
- 中断 → `ctx.abortSignal` kill child（`bash.ts:235-245`）
- 错误语义 → 非零/超时抛 `BashForegroundExecutionError`，catch 块折叠 stdout/stderr 给模型（`bash.ts:638-679`）

**结论**：不要用缓冲式 `executeInSandbox` 替换 `runForegroundCommand`（那会丢掉上述三项能力，需另写代码补回）。改为**命令字符串包装**——复用 seatbelt 的 `generateProfile()` 拼出沙箱命令，仍喂给原封不动的 `runForegroundCommand`。三项能力白嫖，代码量更小。

### 2.3 三个拍板点的最终结论（ASRT 验证后）

| 决策点 | 结论 | 依据 |
|---|---|---|
| **PTY / 后台任务怎么办** | **不 block，统一包装**。PTY（`bash.ts:398`）和 `run_in_background`（`bash.ts:491`）也只是在命令前加沙箱前缀，拿到的仍是合法 shell 命令 | ASRT 进程包装器对交互/后台天然支持，不特殊处理（`cli.js:118` `stdio:'inherit'`） |
| **沙箱不可用时** | **硬报错拒绝执行**，绝不静默降级裸跑。提示装 bwrap / 平台不支持 | ASRT fail-fast：`sandbox-manager.js:160` `throw 'Sandbox dependencies not available'` |
| **流式 + 中断** | **不单独做，白嫖 `runForegroundCommand`** | ASRT 靠 inherit stdio + 信号转发免费获得（`cli.js:140`） |

> 注意：`SandboxManager.execute()`（`manager.ts:225-231`）现在在沙箱不可用时**静默降级** `executeUnsandboxed`。bypass 档必须绕过这个降级，自己先 `isAvailable()` 判定 → 不可用直接报错。

---

## 3. 接线点与模式判定

- `ToolContext`（`src/main/protocol/tools.ts:91`）**不暴露** permissionMode（仅 `sessionId` / `workingDir` / `abortSignal`）。
- 当前模式通过单例 `getPermissionModeManager().getMode()` 获取（`modes.ts:428`；用法见 `multiagentTools/spawnAgent.ts:313`）。
- 判定逻辑（插入位置：`bash.ts:557` 策略硬阻断**之后**、`bash.ts:578` 前台 spawn **之前**）：

```ts
const mode = getPermissionModeManager().getMode();
const shouldSandbox = SANDBOX.OS_SANDBOX_ENABLED && mode === 'bypassPermissions';

if (shouldSandbox && !getSandboxManager().isAvailable()) {
  return {
    ok: false,
    code: 'SANDBOX_UNAVAILABLE',
    error: `bypassPermissions 档要求 OS 沙箱可用：${getSandboxManager().getStatus().error ?? '当前平台不支持'}。` +
      `请安装 bubblewrap（Linux）或切换到 default 档。`,
  };
}
```

---

## 4. 逐文件改动

### 4.1 `src/shared/constants.ts`

新增沙箱 flag（沿用项目"危险能力默认关 + env 启用"惯例，参考 `CODEX_SANDBOX`）：

```ts
export const SANDBOX = {
  /** bypassPermissions 档是否启用 OS 沙箱。默认关，行为零变化。 */
  OS_SANDBOX_ENABLED: process.env.OS_SANDBOX_ENABLED === 'true',
} as const;
```

> `SANDBOX_TIMEOUTS` 已存在（`manager.ts:10` 在用），不动。

### 4.2 `src/main/sandbox/seatbelt.ts` / `bubblewrap.ts` — 暴露"只生成命令"的能力

当前 `generateProfile()` / `writeProfile()` / `cleanupProfile()` 是模块内私有逻辑，被 `execute()` 调用。需要**对外暴露一个"生成沙箱命令字符串 + 返回清理句柄"的方法**，不走缓冲 `execute()`：

```ts
// seatbelt.ts 新增（复用现有 generateProfile / writeProfile / cleanupProfile）
export interface SandboxedCommand {
  /** 包装后可直接交给 spawn(cmd, {shell:true}) 的命令字符串 */
  command: string;
  /** 执行结束后调用，清理临时 profile 文件 */
  cleanup: () => void;
}

wrapCommand(command: string, config: Partial<SeatbeltConfig>): SandboxedCommand {
  const full = { ...DEFAULT_CONFIG, ...config };
  const profile = full.customProfile || generateProfile(full);
  const profilePath = this.writeProfile(profile);
  // 命令引号转义：把原命令安全塞进 -c "..."（用 shell-quote 或等价转义）
  const wrapped = `sandbox-exec -f ${shellQuote(profilePath)} /bin/sh -c ${shellQuote(command)}`;
  return { command: wrapped, cleanup: () => this.cleanupProfile(profilePath) };
}
```

Linux `bubblewrap.ts` 同理：返回 `bwrap <args...> -- /bin/sh -c <quoted command>`。

> ⚠️ 引号转义是 bug 高发点。原命令里的 `"`、`$`、反引号、`\` 必须正确转义，否则要么命令跑错、要么转义逃逸破坏沙箱。用项目已依赖的 `shell-quote`（ASRT 也用这个）或等价方案，并补转义单测。

### 4.3 `src/main/sandbox/manager.ts` — 统一 wrap 入口

```ts
// 类方法
wrapCommand(command: string, config: Partial<SandboxConfig> = {}): SandboxedCommand {
  // 平台分发到 seatbelt.wrapCommand / bubblewrap.wrapCommand
}
// 便捷函数
export function wrapCommandForSandbox(command: string, config?: Partial<SandboxConfig>): SandboxedCommand;
```

`index.ts` 增补导出 `wrapCommandForSandbox` / `SandboxedCommand`。

### 4.4 `src/main/tools/modules/shell/bash.ts` — 接线（核心，改动最小）

1. import：`getPermissionModeManager`、`getSandboxManager`、`wrapCommandForSandbox`、`SANDBOX`。
2. 在 4 个执行分支（PTY `398` / 后台 `491` / 前台 `578`）**之前**统一计算 `shouldSandbox` + 不可用硬报错（见 §3）。
3. 构造 `SandboxConfig`：

```ts
const sbConfig: Partial<SandboxConfig> = {
  ...SandboxManager.forProject(workingDirectory), // 项目目录读写权 + cwd
  allowNetwork: true,            // bypass 档 modes.ts 定义 network=allow
  timeout,
  envPassthrough: ['HOME', 'USER', 'LANG', 'TERM'],
  customEnv: { PATH: shellPathDiagnostics.path }, // 关键：否则沙箱内找不到命令
};
```

4. 各路径包装命令（统一）：

```ts
let sandboxCleanup: (() => void) | undefined;
let execCommand = normalizedCommand;
if (shouldSandbox) {
  const wrapped = wrapCommandForSandbox(normalizedCommand, sbConfig);
  execCommand = wrapped.command;
  sandboxCleanup = wrapped.cleanup;
}
// 前台：runForegroundCommand({ command: execCommand, ... })
// PTY：createPtySession({ command: execCommand, ... })
// 后台：startBackgroundTask(execCommand, ...)
```

5. 在前台 try/finally（以及 PTY/后台对应收尾处）调用 `sandboxCleanup?.()` 删临时 profile。
   - 前台用 `finally` 最稳；后台/PTY 因进程异步存活，profile 需在进程结束回调里清，或挂到 backgroundTasks/ptyExecutor 的生命周期。**这是后台/PTY 路径的额外收尾点，需专门处理（见风险）。**

> `runForegroundCommand` 本体（含流式 / abort / 抛错）**完全不改**——它接到的只是一条更长的命令字符串。

### 4.5 测试

- `bash.sandbox.test.ts`：mock `getMode()` → `bypassPermissions` 断言命令被 `wrapCommandForSandbox` 包装；→ `default` 断言走原始命令。
- `seatbelt.wrapCommand` 转义单测：命令含 `"`/`$`/反引号/`;` 时包装正确且不逃逸。
- 不可用分支：mock `isAvailable()=false` + bypass 档 → 返回 `SANDBOX_UNAVAILABLE`。

---

## 5. 验证阶梯（"写了 ≠ 能用"，重点）

1. `npm run typecheck` 通过。
2. 单测全绿（§4.5）。
3. **真跑（macOS）**：`OS_SANDBOX_ENABLED=true` + 切 bypass 档，跑 `echo hi`、`ls` → 输出正确、命令成功。
4. **隔离实证（最关键）**：跑 `echo x > ~/escape_test`（越界写工作目录外）→ 必须被 seatbelt **挡住**。这条过了才证明沙箱真生效，不只是"能跑"。
5. **PATH / 工具可达（最易炸）**：沙箱内跑 `node -v`、`git status`、`npm -v` → 找得到命令、正常退出。
6. **中断**：跑 `sleep 30` 然后 abort → 进程被杀（验证 `runForegroundCommand` 的 abort 经包装后仍把 child 杀干净，注意进程组 / `sandbox-exec` 子进程树）。
7. **流式**：跑一个分段输出的命令（如 `for i in 1 2 3; do echo $i; sleep 1; done`）→ UI 实时收到 `tool_output_delta`，不是结束才一次性出。
8. **临时文件**：跑若干命令后检查无 seatbelt profile 临时文件泄漏（前台/后台/PTY 都验）。

---

## 6. 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| **profile 正确性（最大）** | `generateProfile()` 从没真跑过，profile 大概率要么太紧（`node`/`git` 跑不起来）要么太松（没隔离） | 验证阶梯第 4、5 条专验此项，预留调 profile 时间 |
| **引号转义** | 原命令塞进 `-c "..."` 转义错 → 命令跑错或转义逃逸破坏沙箱 | 用 `shell-quote`，补转义单测 |
| **后台/PTY 的 profile 清理** | 进程异步存活，profile 不能在调用返回时就删 | 挂到进程结束回调；清理逻辑需穿到 backgroundTasks/ptyExecutor |
| **abort 杀进程树** | `sandbox-exec`/`bwrap` 是父，真正命令是孙；kill 父未必杀孙 | 验证阶梯第 6 条；必要时 detached + 杀进程组 |
| **bypass 档持久化** | `settings.ipc.ts:50` 启动时把持久化的 bypass 重置为 default，且进入 bypass 需用户审批 | 行为符合预期，无需改；测试时手动切档 |

---

## 7. 范围外（v2 候选）

- 网络白名单过滤（ASRT 的 SOCKS/HTTP 代理 + 域名 allowlist）。当前 bypass 档 `allowNetwork: true` 不限网络。
- 其他权限档接入沙箱（本期只做 bypass）。
- Windows 支持（seatbelt/bwrap 均不覆盖，硬报错即可）。
- 把缓冲式 `executeInSandbox` / `SandboxManager.execute()` 标记 deprecated 或删除（本期不动，留作他用）。

---

## 8. 执行顺序

1. `feat/sandbox-bypass` 开分支。
2. 沙箱层：`seatbelt.wrapCommand` / `bubblewrap.wrapCommand` / `manager.wrapCommandForSandbox` + 转义 → typecheck + 转义单测。
3. constants flag。
4. bash.ts 接线（前台先通）→ typecheck + 真跑验证阶梯 3-7。
5. PTY / 后台路径包装 + profile 清理 → 真跑验证。
6. 全验证阶梯过一遍 + 临时文件检查。
7. 每步 commit（功能点级），不积攒。
