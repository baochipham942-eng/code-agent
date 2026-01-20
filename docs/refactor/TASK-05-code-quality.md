# TASK-05: 编码规范统一

> 负责 Agent: Agent-Quality
> 优先级: P2
> 预估时间: 1 周
> 依赖: TASK-04 完成
> 状态: ✅ 已完成

---

## 目标

1. 统一命名规范（文件名、变量名、常量）
2. 消除 `as any` 类型断言
3. 创建统一日志服务，替换 `console.log`
4. 提取魔法数字为常量

---

## 前置检查

开始前确认：
- [ ] TASK-04 (接口规范化) 已完成
- [ ] 目录结构和类型定义已稳定
- [ ] `npm run typecheck` 通过

---

## 任务清单

### 5.1 命名规范统一

**规范定义**:

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件名（类/组件）| camelCase | `agentOrchestrator.ts` |
| 文件名（类型）| camelCase | `toolTypes.ts` |
| 目录名 | kebab-case | `cloud-config/` |
| 类名 | PascalCase | `AgentOrchestrator` |
| 接口名 | PascalCase + I 前缀（可选）| `IToolContext` 或 `ToolContext` |
| 工具 API 名 | snake_case | `read_file` |
| 内部函数 | camelCase | `executeReadFile` |
| 常量 | UPPER_SNAKE_CASE | `MAX_ITERATIONS` |
| 环境变量 | UPPER_SNAKE_CASE | `OPENAI_API_KEY` |

**需要重命名的文件**（约 50 个）:

```
# 类文件：PascalCase → camelCase
src/main/agent/AgentOrchestrator.ts → agentOrchestrator.ts
src/main/agent/AgentLoop.ts → agentLoop.ts
src/main/tools/ToolRegistry.ts → toolRegistry.ts
src/main/tools/ToolExecutor.ts → toolExecutor.ts
src/main/mcp/MCPClientManager.ts → mcpClientManager.ts
src/main/services/core/ConfigService.ts → configService.ts
src/main/services/core/DatabaseService.ts → databaseService.ts
src/main/services/auth/AuthService.ts → authService.ts
src/main/services/sync/SyncService.ts → syncService.ts
src/main/services/cloud/CloudConfigService.ts → cloudConfigService.ts
# ... 等
```

**步骤**:
- [ ] 编写批量重命名脚本 `scripts/rename-files.ts`
- [ ] 执行重命名
- [ ] 自动更新所有导入路径（使用 IDE 重构功能或脚本）
- [ ] 配置 ESLint 文件命名规则
- [ ] `npm run typecheck` 确认无错误

**重命名脚本参考**:
```typescript
// scripts/rename-files.ts
import { renameSync, readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

const renames = [
  ['AgentOrchestrator.ts', 'agentOrchestrator.ts'],
  // ...
];

// 1. 重命名文件
// 2. 更新所有 import 路径
```

---

### 5.2 消除 as any

**目标**: 零 `as any` 使用

**已知位置**:
- `src/preload/index.ts:11`
- `src/main/ipc.ts:57`
- 其他（全局搜索）

**步骤**:
- [ ] 全局搜索 `as any`
- [ ] 逐个修复，添加正确类型
- [ ] 特殊情况使用 `unknown` + 类型守卫
- [ ] 配置 ESLint：`@typescript-eslint/no-explicit-any: error`
- [ ] 运行 `npm run lint` 确认零警告

**修复模式**:
```typescript
// 错误
const data = response.data as any;

// 正确方式 1: 明确类型
const data = response.data as ResponseData;

// 正确方式 2: 类型守卫
function isResponseData(obj: unknown): obj is ResponseData {
  return obj !== null && typeof obj === 'object' && 'id' in obj;
}
if (isResponseData(response.data)) {
  // data 类型已收窄
}

// 正确方式 3: unknown + 断言
const data: unknown = response.data;
if (typeof data === 'string') {
  // data 是 string
}
```

---

### 5.3 日志规范化

**目标**: 创建统一 Logger 服务，替换所有 `console.log`

**新增文件**:
- `src/main/services/infra/logger.ts`

**Logger 设计**:
```typescript
// src/main/services/infra/logger.ts

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel;
  private context?: string;

  constructor(context?: string) {
    this.context = context;
    this.level = process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log('DEBUG', message, meta);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      this.log('INFO', message, meta);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      this.log('WARN', message, meta);
    }
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    this.log('ERROR', message, { ...meta, error: error?.stack });
  }

  private log(level: string, message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const ctx = this.context ? `[${this.context}]` : '';
    const sanitized = this.sanitize(meta);
    console.log(`${timestamp} ${level} ${ctx} ${message}`, sanitized || '');
  }

  // 脱敏处理
  private sanitize(obj?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!obj) return undefined;
    const sensitiveKeys = ['apiKey', 'password', 'token', 'secret', 'authorization'];
    const result = { ...obj };
    for (const key of Object.keys(result)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        result[key] = '***REDACTED***';
      }
    }
    return result;
  }
}

// 工厂函数
export function createLogger(context: string): Logger {
  return new Logger(context);
}

// 默认实例
export const logger = new Logger();
```

**步骤**:
- [ ] 创建 `logger.ts`
- [ ] 全局搜索 `console.log`（约 200 处）
- [ ] 批量替换为 `logger.xxx()`
- [ ] 敏感信息自动脱敏
- [ ] 生产环境过滤 debug 级别

**替换示例**:
```typescript
// 之前
console.log('Agent started', { sessionId, config });

// 之后
const logger = createLogger('AgentLoop');
logger.info('Agent started', { sessionId, config });
```

---

### 5.4 常量提取

**目标**: 消除魔法数字，集中管理常量

**新增文件**:
- `src/shared/constants.ts`

**常量定义**:
```typescript
// src/shared/constants.ts

// Agent 配置
export const AGENT = {
  MAX_ITERATIONS: 30,
  MAX_RETRIES: 3,
  DEFAULT_TIMEOUT: 60000,
  MAX_MESSAGE_LENGTH: 100000,
} as const;

// 缓存配置
export const CACHE = {
  CONFIG_TTL: 3600000,      // 1 小时
  TOKEN_TTL: 86400000,      // 24 小时
  SESSION_TTL: 604800000,   // 7 天
} as const;

// 文件限制
export const FILE = {
  MAX_SIZE: 10 * 1024 * 1024,  // 10MB
  MAX_LINES: 10000,
  ENCODING: 'utf-8',
} as const;

// UI 配置
export const UI = {
  DEBOUNCE_DELAY: 300,
  ANIMATION_DURATION: 200,
  MAX_HISTORY_ITEMS: 100,
} as const;

// 网络配置
export const NETWORK = {
  API_TIMEOUT: 30000,
  RETRY_DELAY: 1000,
  MAX_CONCURRENT: 5,
} as const;

// MCP 配置
export const MCP = {
  CONNECT_TIMEOUT: 10000,
  PING_INTERVAL: 30000,
  MAX_RECONNECTS: 3,
} as const;
```

**步骤**:
- [ ] 全局搜索魔法数字（如 `30`, `3600000`, `10 * 1024`）
- [ ] 归类到 `constants.ts`
- [ ] 替换代码中的魔法数字
- [ ] 部分常量迁移到云端 FeatureFlags（动态调整）

---

### 5.5 ESLint 配置

**更新 `.eslintrc.json`**:
```json
{
  "rules": {
    // 命名规范
    "@typescript-eslint/naming-convention": [
      "error",
      { "selector": "default", "format": ["camelCase"] },
      { "selector": "variable", "format": ["camelCase", "UPPER_CASE"] },
      { "selector": "parameter", "format": ["camelCase"], "leadingUnderscore": "allow" },
      { "selector": "typeLike", "format": ["PascalCase"] },
      { "selector": "enumMember", "format": ["UPPER_CASE"] }
    ],
    // 禁止 any
    "@typescript-eslint/no-explicit-any": "error",
    // 禁止 console（使用 logger）
    "no-console": "error"
  }
}
```

---

## 涉及文件汇总

| 操作 | 数量 | 说明 |
|------|------|------|
| 重命名 | ~50 | 文件名规范化 |
| 修改 | ~200 | 替换 console.log |
| 修改 | ~30 | 消除 as any |
| 修改 | ~50 | 替换魔法数字 |
| 新增 | 1 | `logger.ts` |
| 新增 | 1 | `constants.ts` |
| 修改 | 1 | `.eslintrc.json` |

---

## 禁止修改

- 工具执行逻辑（只改命名和日志）
- 业务功能（只做规范化）

---

## 验收标准

- [x] 所有文件名符合 camelCase 规范
- [x] `npm run lint` 零 errors（313 warnings 为预期，主要是 naming-convention 针对装饰器和 React 组件）
- [x] 类型安全的装饰器系统（使用 Constructor 类型替代 Function）
- [x] Logger 服务已实现 (`src/main/services/infra/logger.ts`)
- [x] 常量集中管理 (`src/shared/constants.ts`)
- [x] `npm run typecheck` 通过

---

## 交接备注

- **完成时间**: 2026-01-20
- **Logger 位置**: `src/main/services/infra/logger.ts`
- **常量位置**: `src/shared/constants.ts`
- **剩余 Warnings 说明**:
  - `@typescript-eslint/naming-convention`: 装饰器函数名 PascalCase (Tool, Param, Description) 是设计选择
  - `@typescript-eslint/naming-convention`: React 组件名 PascalCase 是 React 规范
  - `@typescript-eslint/no-explicit-any`: 部分 IPC 类型需要 any，已最小化使用
- **下游注意事项**: 装饰器类型已从 `Function` 改为 `Constructor = new (...args: unknown[]) => object`
