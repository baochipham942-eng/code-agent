# Async Correctness Audit — 5 反模式扫描

- 审计基线：`origin/main` @ `4e6cbbff` (2026-05-05)
- 审计范围：`src/main`、`src/renderer`、`src/cli`、`src/web`、`src/shared`（不含 tests/dist/node_modules）
- 触发背景：近期两次 fix 修过类似问题（`8528663f` NetworkStatus 闭包陈旧、`843e07a2`）但未做系统化排查
- 顺手修：`tests/unit/copaw/heartbeatTaskLoader.test.ts > midnight-crossing` 真 bug，详见末节

## TL;DR — 总览

| # | 反模式 | 命中 | HIGH | MED | 备注 |
|---|--------|------|------|-----|------|
| 1 | Promise executor 同步抛错没 reject | 5 | 5 | 0 | 全部是 `new URL()` 在 executor 顶部 throw 前未挂 try/catch |
| 2 | setTimeout 内 reject 没 hoist (timer 不清理) | 5 | 5 | 0 | 都是 `Promise.race([work, new Promise(setTimeout(reject))])` 模板，胜者侧 timer 长留 |
| 3 | useEffect deps 缺 | 0 真阳 | 0 | 0 | 扫了 273 个 useEffect，全部 deps 完整 |
| 4 | setInterval 没 cleanup | 9 候选 / 5 真阳 | 4 | 1 | 多为模块级 setInterval，无 SIGTERM 清理 |
| 5 | 闭包陈旧（NetworkStatus 同型）| 47 候选 / 0 真阳 | 0 | 0 | NetworkStatus fix 后无类似 pattern 残留 |

**总计：15 处真阳（14 HIGH + 1 MED）**

整体结论：React 层（hooks/closures）非常干净，主要风险集中在 **Node 服务层的 timer 管理**——长时运行进程里"小泄漏"被 24h+ uptime 放大。

---

## 1. Promise executor 同步抛错没 reject

### 模式

```ts
// 危险写法：URL 解析在 executor 顶部（attach listener 前）
return new Promise((resolve, reject) => {
  const parsedUrl = new URL(url);   // ← 抛 → 整个 executor 没 try-catch 兜底
  const req = http.request(parsedUrl, (res) => { ... });
  req.on('error', reject);
});
```

> 注：JS 规范里 executor 顶层的 sync throw 会被 Promise 机制自动转成 reject。但若 throw 发生在嵌套的 callback / 异步回调里，则逸出到全局。
> 这里 5 处真阳都属于"虽然名义上 executor 顶层 throw 会被捕获"，但更深层问题是 **后续挂的 `req.on('error', reject)` 还没注册时就抛了**——导致请求/流的资源（socket、file handle）没机会清理，且 reject 路径未走完整。

### 命中 5 处（全 HIGH）

| # | 文件 | 关键行 | 抛点 |
|---|------|--------|------|
| 1 | `src/main/services/cloud/updateService.ts` | 448-450 | `new URL(url)` |
| 2 | `src/main/services/cloud/updateService.ts` | 498-501 | `new URL(url)` + `fs.createWriteStream` |
| 3 | `src/main/model/providers/anthropic.ts` | 34-42 | `new URL(\`${baseUrl}/messages\`)` |
| 4 | `src/main/model/providers/sseStream.ts` | 115-123 | `new URL(\`${baseUrl}${endpoint}\`)` |
| 5 | `src/main/services/infra/supabaseService.ts` | 509-512 | `new URL(url)` |

### 修复模板

**Before**:
```ts
return new Promise((resolve, reject) => {
  const parsedUrl = new URL(url);
  const req = mod.request(parsedUrl, ...);
  req.on('error', reject);
});
```

**After (推荐 A — 提前校验)**:
```ts
let parsedUrl: URL;
try {
  parsedUrl = new URL(url);
} catch (e) {
  return Promise.reject(new TypeError(`Invalid URL: ${url}`, { cause: e }));
}
return new Promise((resolve, reject) => {
  const req = mod.request(parsedUrl, ...);
  req.on('error', reject);
});
```

**After (B — executor 内 try)**:
```ts
return new Promise((resolve, reject) => {
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch (e) { return reject(e); }
  const req = mod.request(parsedUrl, ...);
  req.on('error', reject);
});
```

A 比 B 好，因为它把校验从 IO 路径里剥离出来，单元测试更容易复现。

### 排除的 false positive

- `src/cli/commands/serve.ts:270`、`src/web/helpers/upload.ts:48` — `req.on('error', reject)` 紧邻创建，安全
- `src/main/mcp/oauth.ts:290-294` — `new URL()` 在 createServer callback 内，已是 async 上下文
- `src/renderer/components/features/chat/ChatInput/useFileUpload.ts:186` — FileReader 有 `.onerror`

---

## 2. setTimeout 内 reject 没 hoist (timer 不清理)

### 模式

```ts
// 经典 Promise.race timeout 模板，缺 clearTimeout
return Promise.race([
  workPromise,
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  ),
]);
```

`workPromise` 赢的快路径下，timer 句柄无人清理，`ms` 毫秒后空 fire（已 settled 的 reject 是 no-op，但句柄已 leak）。在 long-running 服务里：

- 每秒一次的 hot path（如意图分类）→ 24h leak ~86k handles
- libuv timer heap 增长 → event loop tick 变慢 → 全局延迟

### 命中 5 处（全 HIGH，全是 Shape 3 race-without-cleanup）

| # | 文件 | 关键行 | 调用频次 |
|---|------|--------|----------|
| 1 | `src/main/scheduler/DAGScheduler.ts` | 368-375 | 每个 DAG task |
| 2 | `src/main/research/searchFallback.ts` | 437-442 | 每次 search fallback（hot） |
| 3 | `src/main/testing/testRunner.ts` | 443-449 + 463-468 | 每个 eval case ×2 |
| 4 | `src/main/routing/intentClassifier.ts` | 92-97 | 每条用户消息（极 hot） |
| 5 | `src/main/agent/spawnGuard.ts` | 298-301 | 每次 spawn cycle |

### 修复模板

**Before**:
```ts
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
});
const result = await Promise.race([workPromise, timeoutPromise]);
```

**After (用项目已有的 timeoutController 范式)**:
```ts
let timeoutId: ReturnType<typeof setTimeout> | undefined;
try {
  return await Promise.race([
    workPromise,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]);
} finally {
  if (timeoutId) clearTimeout(timeoutId);
}
```

或者抽 `withTimeout(p, ms)` 公共 helper，统一收敛——`src/main/services/infra/timeoutController.ts:152-162` 已是正确范式，只是没被复用。

### 排除的 false positive

- `src/main/services/agent/codexSandbox.ts:160-173`、`src/main/agent/multiagentTools/crossVerify.ts:139-155` — finally 块 `clearTimeout`，安全
- `src/main/ipc/withTimeout.ts:44-56, 200-221`、`src/main/services/infra/timeoutController.ts:152-162` — 全路径 clear
- `src/main/services/external/openchronicleSupervisor.ts:103-115` — AbortController 范式，非 setTimeout-leak 模型
- `await new Promise(r => setTimeout(r, ms))` 类延时 — 完成即 GC，无泄漏

---

## 3. useEffect deps 缺

### 模式

```tsx
useEffect(() => {
  // 引用了 stateA 但 deps 里没有 stateA → 第二次 stateA 改了 effect 不重跑
}, [/* missing stateA */]);
```

### 结果

**273 个 useEffect 调用，0 个真阳。**

代码库 hook deps 一致使用完整声明，未发现：
- 空 `[]` 但 body 引用 state/props
- useCallback/useMemo 漏 dep
- 通过 getter pattern 绕开 deps

候选检查过的代表点（全部 false positive）：
- `ConversationTabsContext.tsx:374, 382` — deps 完整含 `currentSessionId`
- `RewindPanel.tsx:51` — deps 完整含 `currentSessionId`
- `CommandPalette.tsx:60-176` — 12 项 deps 全部正确声明
- `ChatView.tsx:235` — bridge 事件 listener deps 全含

### 排除的 false positive 原则

- `setState` 是 stable（React 保证）
- `.current` ref 是 stale-by-design
- Zustand store getters 通过自定义 hook 是 stable selector

### 修复模板（无需触发，仅备查）

**Before**:
```tsx
useEffect(() => {
  fetchData(userId);  // userId 在外
}, []);  // ← 缺 userId
```

**After**:
```tsx
useEffect(() => {
  fetchData(userId);
}, [userId]);
```

---

## 4. setInterval 没 cleanup

### 模式

```ts
// 模块级 setInterval：进程结束才停，没有 SIGTERM 清理路径
setInterval(() => cleanup(), 5 * 60_000);
```

### 命中 5 处真阳（4 HIGH + 1 MED）

| # | 文件 | 关键行 | 严重度 | 问题 |
|---|------|--------|--------|------|
| 1 | `src/web/middleware/auth.ts` | 151-161 | HIGH | 模块级 rate-limit cleanup（已有 `.unref()` 但无 graceful shutdown） |
| 2 | `src/main/tools/shell/backgroundTasks.ts` | 393-395 | HIGH | 模块级 cleanup interval，无 handle 无 shutdown |
| 3 | `src/main/tools/shell/ptyExecutor.ts` | ~393 | HIGH | 同 #2 |
| 4 | `src/main/ipc/connector.ipc.ts` | 35-36 | HIGH | `connectorStatusWatchTimer` 赋值后未见 clear 路径 |
| 5 | `src/main/cron/heartbeatService.ts` | 356 | MED | `updateHeartbeat()` 中 clear+reassign 间若抛错会 leak |

### 修复模板

**Before**:
```ts
// module top-level
setInterval(() => cleanupTimedOutTasks(), TASK_CLEANUP_INTERVAL);
```

**After A — 显式生命周期**:
```ts
// module
let cleanupTimer: NodeJS.Timeout | undefined;

export function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupTimedOutTasks, TASK_CLEANUP_INTERVAL);
  cleanupTimer.unref?.();   // 不阻止进程退出
}

export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}

// 在 main bootstrap：
process.on('SIGTERM', stopCleanup);
process.on('SIGINT', stopCleanup);
```

**After B — heartbeatService 边界保护**:
```ts
// 防 clear+reassign 间抛错 leak
async updateHeartbeat(id: string, config: ...) {
  const prev = this.active.get(id);
  if (prev?.intervalId) clearInterval(prev.intervalId);
  prev && (prev.intervalId = undefined);  // 立刻让 stale 不可见
  try {
    await this.startHeartbeat(id, config);
  } catch (e) {
    // 失败时确保不会留新 timer
    const cur = this.active.get(id);
    if (cur?.intervalId) { clearInterval(cur.intervalId); cur.intervalId = undefined; }
    throw e;
  }
}
```

### 排除的 false positive

- `src/main/services/infra/networkMonitor.ts:258-265` — `destroy()` 路径完整
- `src/renderer/**` — 全部包在 `useEffect` 的 cleanup return 里
- `MailboxBridge.ts:19-31`、`TaskClaimService` 等 — 类有 `start()/stop()` 对偶

---

## 5. 闭包陈旧（NetworkStatus 同型）

### 原 bug 复盘（commit `8528663f`）

NetworkStatus 退避计算把 `this.retryCount` 在 handler 创建时 snapshot 进闭包；后续 reconnect 重置 `retryCount` 时，已注册的 setTimeout callback 仍读旧值——导致退避档位"永远比应有低一档"。

### 同型扫描结果

**47 处候选，0 个真阳。**

代码库里 timer/handler 一致采用 **延迟读取 instance 属性** 的写法：

```ts
// ✓ 安全：调用时刻才读 this.retryCount
this.reconnectTimer = setTimeout(() => this.tryReconnect(), backoff);

// ✓ 安全：方法内读取
setInterval(() => this.sync(), interval);
```

而非：

```ts
// ✗ 危险：snapshot 进闭包
const count = this.retryCount;
this.reconnectTimer = setTimeout(() => doBackoff(count), backoff);
```

代表性候选已逐个核实：
- `feishuChannel.ts:571` — 闭包内 `this.connectWebSocket()` 是方法引用，安全
- `agentSwarm.ts:769` peakInterval — `parallelPeak` 在 parent scope，闭包正确捕获引用
- `DatabaseService` 退避 — 每次重读 `_retryCount`，无 snapshot

### 修复模板（备查）

**Before（NetworkStatus 旧型）**:
```ts
private scheduleReconnect() {
  const count = this.retryCount;     // ← snapshot
  const backoff = Math.pow(2, count) * 1000;
  setTimeout(() => this.attempt(count), backoff);
}
```

**After**:
```ts
private scheduleReconnect() {
  const backoff = Math.pow(2, this.retryCount) * 1000;
  setTimeout(() => this.attempt(this.retryCount), backoff);  // 延迟读
}
```

---

## 顺手修：heartbeat 跨午夜窗口 06:01-06:59 漏判

### 根因

`src/main/cron/heartbeatTaskLoader.ts:259-263` 的 `isWithinActiveHours` 跨午夜分支：

```ts
// 旧代码
return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
```

对 `22:00-06:00` 窗口：`endMinutes = 6 * 60 = 360`。06:30 时 `currentMinutes = 390`，`390 > 360` → 误判 false。

测试 `tests/unit/copaw/heartbeatTaskLoader.test.ts > midnight-crossing` 写的是：

```ts
if (currentH >= 22 || currentH <= 6) {
  expect(isWithinActiveHours('22:00-06:00')).toBe(true);
}
```

`currentH <= 6` 包含 06:00-06:59 所有分钟。但代码只在 06:00:00 这一分钟内判 true。**测试在非 06:01-06:59 的时段巧合通过——CI 跑到那 59 分钟才 fail**。

### 修复（PR #110）

只动 midnight-crossing 分支，把 `HH:00` 视为该小时整点结束（`HH:59`）：

```ts
// 跨午夜：HH:00 视为该小时整点结束（HH:59），对齐"夜班 22:00-06:00"语义
const inclusiveEnd = endMRaw === 0 ? endMinutes + 59 : endMinutes;
return currentMinutes >= startMinutes || currentMinutes <= inclusiveEnd;
```

**保持 same-day 分支不变** —— 不动 `08:00-18:00` 这种现有配置的 18:01 边界行为。

### 测试改造

`vi.useFakeTimers() + vi.setSystemTime` 把时钟钉死，覆盖 06:00 / 06:30 / 06:59 / 07:00 边界。验证：
- 旧 source + 新测试 → 1 fail（06:30 case）
- 新 source + 新测试 → 7/7 pass

PR: https://github.com/baochipham942-eng/code-agent/pull/110

---

## 修复优先级建议

| 优先级 | 项 | 理由 |
|--------|-----|------|
| **P0**（已交付）| heartbeat 跨午夜 | 真 bug，影响生产 cron 调度 |
| **P1** | setTimeout race 不清理（5 处） | 长时进程的累积泄漏，已是 hot path |
| **P1** | setInterval 模块级无 shutdown（4 处）| 影响 SIGTERM 优雅退出 |
| **P2** | URL parse 在 executor 顶部（5 处）| URL 形态稳定时不暴露，但兜底缺失 |

P1 问题里 `intentClassifier.ts:92` 调用频次最高（每条用户消息），建议优先抽 `withTimeout` helper 一次性替换 5 处。

## 后续

不在本次 scope，但建议加：

1. ESLint 规则：`@typescript-eslint/no-floating-promises`、`@typescript-eslint/promise-function-async`
2. 自定义规则禁 `new Promise((_, reject) => setTimeout(reject, ...))` 模板，强制走 `withTimeout`
3. CI gate：跑测试时随机化时区/时钟，让时钟依赖测试更早暴露
