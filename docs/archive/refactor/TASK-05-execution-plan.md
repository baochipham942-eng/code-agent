# TASK-05 执行计划

## 工作量统计

| 任务 | 文件数 | 修改处 | 复杂度 |
|------|--------|--------|--------|
| 5.3 日志规范化 | 91 | 589 | 中 |
| - src/main | 59 | 474 | |
| - src/renderer | 23 | 100 | |
| - vercel-api | 9 | 15 | |
| 5.4 常量提取 | ~79 | ~203 | 低 |
| 5.2 消除 as any | 24 | ~50 | 中 |
| 5.1 文件重命名 | ~100 | ~500 imports | 高 |
| 5.5 ESLint 配置 | 1 | - | 低 |

---

## 执行阶段

### 阶段 1: 基础设施 (串行)

**Agent-Infra** - 1 个 Agent

1. 创建 `src/main/services/infra/logger.ts`
2. 创建 `src/shared/constants.ts`
3. 验证 typecheck

**预计**: 30 分钟

---

### 阶段 2: 日志替换 (3 个 Agent 并行)

同时启动 3 个 Agent，各自负责一个目录：

| Agent | 目录 | 文件数 | console 数 |
|-------|------|--------|-----------|
| **Agent-Log-Main** | src/main/ | 59 | 474 |
| **Agent-Log-Renderer** | src/renderer/ | 23 | 100 |
| **Agent-Log-Vercel** | vercel-api/ | 9 | 15 |

**每个 Agent 任务**:
1. 替换目录下所有 console.log/warn/error/info/debug
2. 添加 import { createLogger } from '...'
3. 验证 typecheck

**验收**: 3 个 Agent 都完成后，运行全局 typecheck

**预计**: 1-2 小时（并行）

---

### 阶段 3: 常量提取 (2 个 Agent 并行)

| Agent | 目录 | 说明 |
|-------|------|------|
| **Agent-Const-Main** | src/main/ | 后端常量 |
| **Agent-Const-Renderer** | src/renderer/ | 前端常量 |

**每个 Agent 任务**:
1. 搜索魔法数字 (timeout, retry, size 等)
2. 替换为 `AGENT.XXX`, `CACHE.XXX` 等
3. 验证 typecheck

**验收**: typecheck 通过

**预计**: 1 小时（并行）

---

### 阶段 4: 消除 as any (2 个 Agent 并行)

| Agent | 文件范围 | 数量 |
|-------|----------|------|
| **Agent-Type-Core** | main 进程核心 | ~15 |
| **Agent-Type-Other** | renderer + vercel | ~9 |

**as any 文件分布**:
```
Core (15):
- src/main/agent/*.ts (2)
- src/main/services/**/*.ts (7)
- src/main/memory/*.ts (1)
- src/main/cloud/*.ts (2)
- src/main/model/*.ts (1)
- src/main/orchestrator/*.ts (2)

Other (9):
- src/renderer/stores/*.ts (1)
- src/preload/index.ts (1)
- src/main/ipc/*.ts (1)
- vercel-api/**/*.ts (4)
- tests/*.ts (1)
- scripts/*.ts (1)
```

**每个 Agent 任务**:
1. 修复 as any，使用正确类型或 unknown + 类型守卫
2. 验证 typecheck

**预计**: 1-2 小时（并行）

---

### 阶段 5: 文件重命名 (串行，分批)

**Agent-Rename** - 1 个 Agent，分 5 批执行

这是风险最高的任务，必须串行分批：

| 批次 | 目录 | 文件数 |
|------|------|--------|
| 1 | src/main/services/ | ~20 |
| 2 | src/main/agent/ + src/main/tools/ | ~25 |
| 3 | src/main/mcp/ + src/main/memory/ | ~15 |
| 4 | src/main/orchestrator/ + src/main/cloud/ | ~20 |
| 5 | src/renderer/ + 其他 | ~20 |

**每批流程**:
1. 重命名该目录下的 PascalCase 文件
2. 更新所有 import 路径
3. 运行 typecheck 验证
4. 确认无误后进入下一批

**预计**: 2-3 小时（串行）

---

### 阶段 6: ESLint 配置 (串行)

**Agent-Lint** - 1 个 Agent

1. 更新 `.eslintrc.json` 添加规则
2. 运行 `npm run lint`
3. 修复剩余警告

**预计**: 30 分钟

---

## Agent 汇总

| 阶段 | Agent 数量 | 并行/串行 | 预计时间 |
|------|-----------|-----------|----------|
| 1 基础设施 | 1 | 串行 | 30 min |
| 2 日志替换 | 3 | **并行** | 1-2 h |
| 3 常量提取 | 2 | **并行** | 1 h |
| 4 消除 any | 2 | **并行** | 1-2 h |
| 5 文件重命名 | 1 | 串行(5批) | 2-3 h |
| 6 ESLint | 1 | 串行 | 30 min |

**总计**: 最多 10 个 Agent，峰值 3 个并行

---

## 验收检查点

每个阶段完成后必须验证：

```bash
# 1. 类型检查
npm run typecheck

# 2. 构建测试
npm run build

# 3. 启动测试
npm run dev
```

---

## 回滚策略

每个阶段开始前创建 git tag：

```bash
git tag task-05-phase-1-start
git tag task-05-phase-2-start
# ...
```

出问题时可以回滚：
```bash
git reset --hard task-05-phase-X-start
```
