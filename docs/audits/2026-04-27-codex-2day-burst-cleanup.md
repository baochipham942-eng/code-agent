# Audit: 2 天作业清理（艾克斯本人修这 4 个简单点）

**Date**: 2026-04-27
**Scope**: 仅修以下 4 个明确点。**不要**碰 protocol 层架构（那是 Claude 在另一个分支处理）。
**Reviewer**: Claude (Laura)
**Implementer**: 艾克斯（你）

## 硬护栏（基于 2026-04-24 dogfood 教训）

1. **scope 锁死**：只动下面列出的 4 个文件中的具体行。其他文件一律不准碰。
2. **反 docs 污染**：不要写新 docs/plans/ 文档；不要修 ARCHITECTURE.md；不要在已有文档里加段落。
3. **per-finding commit**：每修一个 finding 一个独立 commit，commit message 引用 finding ID（M1.1 / M2.3 / M2.4 / M2.5）。
4. **dry-run gate**：每个 commit 之前必须本地跑 `npm run typecheck` 和针对该文件的 lint，PASS 才能提交。
5. **TDD when possible**：能加 test 就加，不能加（cosmetic 改动）就在 commit message 里写明 "no behavior change, lint-only"。

---

## Finding M1.1 — `runShim` async Promise executor (HIGH)

**File**: `src/main/services/external/openchronicleSupervisor.ts`
**Line**: 81-95
**Lint rule**: `no-async-promise-executor`

**当前代码**:
```ts
function runShim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const shim = await resolveShim();
    if (!shim) {
      resolve({ code: -1, stdout: '', stderr: 'openchronicle CLI not found' });
      return;
    }
    const proc = spawn(shim, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // ...
  });
}
```

**问题**：Promise executor 用 `async`，如果 `resolveShim()` 同步抛异常（理论可能），Promise 永远不 settle。`no-async-promise-executor` lint 规则就是为这个。

**Fix**：把 `resolveShim()` 提到 Promise 外面：
```ts
async function runShim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const shim = await resolveShim();
  if (!shim) {
    return { code: -1, stdout: '', stderr: 'openchronicle CLI not found' };
  }
  return new Promise((resolve) => {
    const proc = spawn(shim, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
  });
}
```

**验收**：
- `npx eslint src/main/services/external/openchronicleSupervisor.ts` 不再有 `no-async-promise-executor` 报错
- `npm run typecheck` PASS
- 不需要新加 test（行为不变）

**Commit message**: `fix(openchronicle): hoist resolveShim out of Promise executor (M1.1)`

---

## Finding M2.3 — `MCP_HEALTH_URL` 重复硬编码 (MED)

**Files**:
- `src/main/services/external/openchronicleSupervisor.ts:36` (`MCP_HEALTH_URL = 'http://127.0.0.1:8742/mcp'`)
- `src/main/services/external/openchronicleContextProvider.ts:15` (`MCP_URL = 'http://127.0.0.1:8742/mcp'`)

**问题**：同一 URL 在两个文件各定义一次，违反 DRY。

**Fix**：
1. 在 `src/shared/contract/openchronicle.ts` 末尾加：
   ```ts
   export const OPENCHRONICLE_MCP_ENDPOINT = 'http://127.0.0.1:8742/mcp';
   ```
2. supervisor 和 contextProvider 都从这个常量 import 使用，删掉两处本地常量。

**验收**：
- `grep -rn '8742' src/` 只在 `shared/contract/openchronicle.ts` 出现
- `npm run typecheck` PASS
- `npm run test -- openchronicle` 不退步（之前就过的现在也过）

**Commit message**: `refactor(openchronicle): centralize MCP endpoint constant (M2.3)`

---

## Finding M2.4 — devServerManager ANSI regex no-control-regex (LOW)

**File**: `src/main/services/infra/devServerManager.ts`
**Line**: 237

**当前代码**:
```ts
const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
```

**问题**：`\x1b` 触发 lint `no-control-regex`，但这是**故意**的（剥 ANSI 颜色码）。

**Fix**：在该行上方加单行 disable，并把 `\x1b` 改成 ``（更标准）：
```ts
// eslint-disable-next-line no-control-regex
const trimmed = line.replace(/\[[0-9;]*m/g, '').trimEnd();
```

**注意**：`tests/renderer/components/.../ToolDetails.tsx:45` 和 `ToolCallDisplay/index.tsx:218` 也有同模式，**不要**碰这两处（不在本次 scope 内，那是 renderer 上的展示逻辑，留给独立 finding）。

**验收**：
- `npx eslint src/main/services/infra/devServerManager.ts` 不再报 `no-control-regex`
- `npm run typecheck` PASS

**Commit message**: `style(devServerManager): silence intentional ANSI control-regex (M2.4)`

---

## Finding M2.5 — react-hooks/exhaustive-deps "rule not found" (LOW)

**Files**:
- `src/renderer/components/features/chat/MessageBubble/MessageContent.tsx:233`
- `src/renderer/components/features/settings/tabs/UpdateSettings.tsx:123`
- `src/renderer/components/features/workflow/DAGViewer.tsx:151`

**问题**：这 3 个文件有 `// eslint-disable-next-line react-hooks/exhaustive-deps` 注释，但 eslint config 已经不启用 `react-hooks/exhaustive-deps` 规则了，所以现在反而报 "Definition for rule … was not found" error。

**Fix**：直接删掉这 3 行 disable 注释（保留注释下面的代码不变）。

**验收**：
- `npx eslint <those 3 files>` 不再报 "Definition for rule 'react-hooks/exhaustive-deps' was not found"
- `npm run typecheck` PASS
- `npm run test -- <those 3 components>` 不退步

**Commit message**: `chore(lint): remove dangling react-hooks disable comments (M2.5)`

---

## 完成后

最后一步：跑完整 lint 把数据交给 Claude
```bash
npm run typecheck
npx eslint src --ext .ts,.tsx --quiet 2>&1 | tail -3
```

把输出贴回来即可。Claude 会接着跑 protocol 层重构（M1.2）。
